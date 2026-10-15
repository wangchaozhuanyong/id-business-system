import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  Amount4,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeOnlineOrderRepository } from './persistence/bank-recharge-online-order.repository';
import {
  bankRechargeCountryCode,
  bankRechargeCurrency,
  bankRechargeDate,
  bankRechargeEmail,
  bankRechargeId,
  bankRechargeMaskedEmail,
  bankRechargeMoney,
  bankRechargeText
} from './bank-recharge-validation';

/** 由线上域验证官方原单后传入；此契约不接受 Session、密码或安全码。 */
export interface VerifiedOnlineRechargeOrderFact {
  taskId: string;
  actorUserId: string | null;
  provider: string;
  plan: 'plus' | 'pro_5x' | 'pro_20x' | 'pro_500';
  accountKey: string | null;
  emailEncrypted: string | null;
  cardId: string | null;
  cardLabel: string | null;
  cardLast4: string | null;
  chargeAmount: string | null;
  chargeCurrencyCode: string | null;
  chargeCountryCode: string | null;
  paymentReference: string | null;
  checkoutIdentifier: string | null;
  zeroAmountChange: boolean;
  paymentKind: 'initial' | 'upgrade' | 'unknown';
  verifiedAt: string;
  openedAt: string | null;
  dueAt: string | null;
}
const factKeys = new Set([
  'taskId',
  'actorUserId',
  'provider',
  'plan',
  'accountKey',
  'emailEncrypted',
  'cardId',
  'cardLabel',
  'cardLast4',
  'chargeAmount',
  'chargeCurrencyCode',
  'chargeCountryCode',
  'paymentReference',
  'checkoutIdentifier',
  'zeroAmountChange',
  'paymentKind',
  'verifiedAt',
  'openedAt',
  'dueAt'
]);
const plans = { plus: 'plus', pro_5x: 'pro-5x', pro_20x: 'pro-20x', pro_500: 'pro-500' } as const;
function reference(value: string | null, label: string) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,220}$/.test(value))
    throw new BadRequestException(`${label}格式无效`);
  return value;
}

@Injectable()
export class BankRechargeOnlineOrderService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly online: BankRechargeOnlineOrderRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async syncInTransaction(tx: V2CommandTransaction, fact: VerifiedOnlineRechargeOrderFact) {
    if (
      !fact ||
      typeof fact !== 'object' ||
      Array.isArray(fact) ||
      Object.keys(fact).length !== factKeys.size ||
      Object.keys(fact).some((key) => !factKeys.has(key)) ||
      [...factKeys].some((key) => !Object.hasOwn(fact, key))
    )
      throw new BadRequestException('线上原单事实结构无效');
    bankRechargeId(fact.taskId, '线上原充值任务');
    if (fact.actorUserId !== null) bankRechargeId(fact.actorUserId, '操作人');
    if (!Object.hasOwn(plans, fact.plan)) throw new BadRequestException('线上订单套餐无效');
    if (
      !['initial', 'upgrade', 'unknown'].includes(fact.paymentKind) ||
      typeof fact.zeroAmountChange !== 'boolean'
    )
      throw new BadRequestException('线上付款类型无效');
    const provider = bankRechargeText(fact.provider, '执行来源', 40);
    if (!['local', 'third_party'].includes(provider)) throw new BadRequestException('执行来源无效');
    const accountKey = fact.accountKey;
    if (
      accountKey !== null &&
      (typeof accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(accountKey))
    )
      throw new BadRequestException('官网身份指纹格式无效');
    const currency =
      fact.chargeCurrencyCode === null ? null : bankRechargeCurrency(fact.chargeCurrencyCode);
    const amount =
      fact.chargeAmount === null
        ? null
        : bankRechargeMoney(fact.chargeAmount, '官网实付金额').toString();
    if (amount !== null && Amount4.from(amount).isZero() && !fact.zeroAmountChange)
      throw new BadRequestException('零元变更必须有明确官网证据');
    if (
      fact.zeroAmountChange &&
      (fact.paymentKind !== 'upgrade' || amount === null || !Amount4.from(amount).isZero())
    )
      throw new BadRequestException('零元变更证据不一致');
    const paymentReference = reference(fact.paymentReference, '付款凭据');
    const checkoutIdentifier = reference(fact.checkoutIdentifier, '结算标识');
    const verifiedAt = bankRechargeDate(fact.verifiedAt, '原单核实时间');
    const openedAt =
      fact.openedAt === null ? null : bankRechargeDate(fact.openedAt, '实际开通时间');
    const dueAt = fact.dueAt === null ? null : bankRechargeDate(fact.dueAt, '官网到期时间');
    if (openedAt && dueAt && dueAt <= openedAt) throw new BadRequestException('官网日期顺序无效');
    const country = bankRechargeCountryCode(fact.chargeCountryCode);
    if (fact.cardLast4 !== null && !/^\d{4}$/.test(fact.cardLast4))
      throw new BadRequestException('银行卡尾号无效');
    const cardId = fact.cardId === null ? null : bankRechargeId(fact.cardId, '线上银行卡');
    const card = cardId ? await this.online.findCard(tx, cardId) : null;
    if (card && fact.cardLast4 && card.last4 !== fact.cardLast4)
      throw new ConflictException('原单卡号证据与线上卡池不一致');
    const prior = await this.online.findExisting(
      tx,
      fact.taskId,
      paymentReference,
      checkoutIdentifier
    );
    if (prior.length) {
      const existing = prior[0]!;
      if (
        prior.length !== 1 ||
        existing.channel !== 'online' ||
        existing.onlineRechargeTaskId !== fact.taskId ||
        existing.paymentEvidenceId !== paymentReference ||
        existing.checkoutIdentifier !== checkoutIdentifier ||
        existing.plan !== plans[fact.plan] ||
        (amount !== null &&
          existing.chargeAmount !== null &&
          !Amount4.from(existing.chargeAmount).equals(amount)) ||
        (currency && existing.chargeCurrencyCode && existing.chargeCurrencyCode !== currency)
      )
        throw new ConflictException('原付款凭据已关联其他订单或事实冲突，请人工核对');
      return existing;
    }
    const accountId = await this.ensureAccount(tx, fact, accountKey);
    const snapshot = {
      provider,
      accountKey,
      rawPlan: fact.plan,
      paymentKind: fact.paymentKind,
      originalCardId: cardId,
      cardLast4: fact.cardLast4 ?? card?.last4 ?? null,
      zeroAmountChange: fact.zeroAmountChange,
      chargeCountryCode: country,
      verifiedChargeAmount: amount,
      verifiedChargeCurrencyCode: currency,
      verifiedPaymentReference: paymentReference,
      verifiedCheckoutIdentifier: checkoutIdentifier,
      verifiedAt: verifiedAt.toISOString()
    };
    const item = await this.repository.createOrder(tx, {
      data: {
        orderNo: `ON${new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, '')
          .slice(0, 14)}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        channel: 'online',
        source: 'automatic',
        onlineRechargeTaskId: fact.taskId,
        onlineRechargeCardId: card?.id ?? null,
        cardId: null,
        cardLast4: fact.cardLast4 ?? card?.last4 ?? null,
        cardLabelSnapshot:
          fact.cardLast4 || card?.last4 ? `线上银行卡 ····${fact.cardLast4 ?? card?.last4}` : null,
        onlineSourceSnapshot: toV2JsonDocument(snapshot),
        paymentEvidenceId: paymentReference,
        checkoutIdentifier,
        accountId,
        plan: plans[fact.plan],
        chargeAmount: amount,
        chargeCurrencyCode: currency,
        accountingVersion: 'subscription_cost_v2',
        status: 'pending_details',
        financeStatus: 'unposted',
        openedAt,
        dueAt,
        verifiedAt,
        createdByUserId: fact.actorUserId,
        updatedByUserId: fact.actorUserId
      }
    });
    await this.audit.append(tx, {
      userId: fact.actorUserId ?? undefined,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.order.create_from_online',
      objectType: 'bank_recharge_order',
      objectId: item.id,
      afterData: toV2JsonDocument({
        orderNo: item.orderNo,
        taskId: fact.taskId,
        channel: 'online',
        status: item.status,
        accountId,
        chargeAmount: amount,
        chargeCurrencyCode: currency,
        zeroAmountChange: fact.zeroAmountChange
      }),
      remark: '线上原单已核实，生成待补全订单；未执行付款或财务入账'
    });
    return item;
  }

  private async ensureAccount(
    tx: V2CommandTransaction,
    fact: VerifiedOnlineRechargeOrderFact,
    accountKey: string | null
  ) {
    if (!accountKey) return null;
    let email: string | null = null;
    if (fact.emailEncrypted) {
      try {
        email = bankRechargeEmail(this.encryption.decrypt(fact.emailEncrypted));
      } catch {
        return null;
      }
    }
    const official = await this.repository.findAccountByOfficialKey(tx, accountKey);
    if (!email)
      return official && !official.deletedAt && official.status === 'active' ? official.id : null;
    const hash = this.encryption.hash(email)!;
    const byEmail = await this.repository.findAccountByEmailHash(tx, hash);
    if (official && official.id !== byEmail?.id) return null;
    if (byEmail) {
      if (
        byEmail.deletedAt ||
        byEmail.status !== 'active' ||
        (byEmail.officialAccountKey && byEmail.officialAccountKey !== accountKey)
      )
        return null;
      if (!byEmail.officialAccountKey) {
        await this.repository.updateAccount(tx, {
          where: { id: byEmail.id },
          data: { officialAccountKey: accountKey }
        });
        await this.audit.append(tx, {
          userId: fact.actorUserId ?? undefined,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.bind_from_online',
          objectType: 'chatgpt_account',
          objectId: byEmail.id,
          afterData: { taskId: fact.taskId, officialAccountKey: accountKey },
          remark: '线上原单身份与原账号邮箱一致，关联官网身份指纹'
        });
      }
      return byEmail.id;
    }
    const account = await this.repository.createAccount(tx, {
      data: {
        emailEncrypted: this.encryption.encrypt(email)!,
        emailHash: hash,
        emailMasked: bankRechargeMaskedEmail(email),
        officialAccountKey: accountKey,
        createdByUserId: fact.actorUserId,
        updatedByUserId: fact.actorUserId
      }
    });
    await this.audit.append(tx, {
      userId: fact.actorUserId ?? undefined,
      module: 'id_business_v2',
      action: 'id_business_v2.auto_recharge.chatgpt_account.create_from_online',
      objectType: 'chatgpt_account',
      objectId: account.id,
      afterData: { emailMasked: account.emailMasked, taskId: fact.taskId },
      remark: '线上原单成功后关联官网账号，未复制登录凭据'
    });
    return account.id;
  }
}
