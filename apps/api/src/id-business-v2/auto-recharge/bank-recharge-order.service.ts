import { createManualBankRechargeOrder } from './bank-recharge-manual-order';
import { recordVerifiedBankRechargeOrder } from './bank-recharge-verified-order';
import {
  assertBankRechargeChannelAccess,
  bankRechargePaymentAccountKey,
  onlineOrderSnapshot
} from './bank-recharge-channel';
import { bankRechargeOrderAuditSnapshot } from './bank-recharge-order-audit';
import { BankRechargeFeesService, BANK_RECHARGE_FEE_PREFIXES } from './bank-recharge-fees.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { V2_BANK_RECHARGE_PLANS, bankRechargeDefaultDueAt } from '@apple-business/shared';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  toV2JsonDocument,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  type V2CommandContext,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { bankRechargeCardSnapshot } from './bank-recharge-card-summary';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { activateBankRechargeSubscription } from './bank-recharge-subscription-projection';
import {
  bankRechargeCurrency,
  bankRechargeDate,
  bankRechargeFee,
  bankRechargeFeeRate,
  bankRechargeFxRate,
  bankRechargeId,
  bankRechargeMoney,
  bankRechargeObject,
  bankRechargeOptionalId,
  bankRechargeText
} from './bank-recharge-validation';

const plans = new Set<string>(V2_BANK_RECHARGE_PLANS);
const editable = new Set([
  'confirmFeeConversion',
  ...BANK_RECHARGE_FEE_PREFIXES.flatMap((prefix) =>
    ['Amount', 'CurrencyCode', 'FinanceAccountId', 'FxRateToCny', 'ManualRateReason'].map(
      (suffix) => `${prefix}${suffix}`
    )
  ),
  'expectedUpdatedAt',
  'customerId',
  'accountId',
  'cardId',
  'onlineRechargeCardId',
  'paymentEvidenceRef',
  'customerFeeRate',
  'customerFeeAmount',
  'bankFeeAmount',
  'bankFeeCurrencyCode',
  'receivedAmount',
  'receivedCurrencyCode',
  'chargeFxRateToCny',
  'bankFeeFxRateToCny',
  'receivedFxRateToCny',
  'fundingFinanceAccountId',
  'receivedFinanceAccountId',
  'openedAt',
  'dueAt',
  'remark',
  'chargeAmount',
  'chargeCurrencyCode',
  'plan'
]);

@Injectable()
export class BankRechargeOrderService {
  constructor(
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly accounts: BankRechargeAccountService,
    private readonly repository: BankRechargeRepository,
    private readonly fees: BankRechargeFeesService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async createManual(value: unknown, operator: AuthenticatedUser) {
    return createManualBankRechargeOrder(value, operator, {
      transactions: this.transactions,
      audit: this.audit,
      accounts: this.accounts,
      repository: this.repository,
      encryption: this.encryption,
      requireCustomer: (tx, id) => this.requireCustomer(tx, id),
      requireCard: (tx, id) => this.requireCard(tx, id),
      requireOnlineCard: (tx, id) => this.requireOnlineCard(tx, id),
      plan: (plan) => this.plan(plan),
      orderNo: () => this.orderNo(),
      assertDates: (openedAt, dueAt) => this.assertDates(openedAt, dueAt)
    });
  }
  async update(id: string, value: unknown, operator: AuthenticatedUser) {
    return this.transactions.execute(
      (tx, context) => this.updateInTransaction(tx, id, value, operator, context),
      {
        changedScopes: ['auto-recharge', 'renewals', 'renewal-warning-summary', 'dashboard'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }
  async updateInTransaction(
    tx: V2CommandTransaction,
    id: string,
    value: unknown,
    operator: AuthenticatedUser,
    context: V2CommandContext
  ) {
    bankRechargeId(id, '银充订单');
    const input = bankRechargeObject(value);
    if (Object.keys(input).some((key) => !editable.has(key))) {
      throw new BadRequestException('银充订单包含不可修改字段');
    }
    const expectedUpdatedAt = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银充订单');

    const previous = await this.repository.findOrder(tx, id);
    if (!previous) throw new NotFoundException('银充订单不存在');
    assertBankRechargeChannelAccess(previous.channel, operator, true);
    const online = previous.channel === 'online';
    if (online ? Boolean(input.cardId) : Boolean(input.onlineRechargeCardId))
      throw new BadRequestException('银行卡必须属于当前订单渠道');
    if (['completed', 'refunded', 'cancelled'].includes(previous.status)) {
      throw new ConflictException('已完成或已结束的银充订单不能直接改写，请走更正或退款流程');
    }
    assertV2ExpectedUpdatedAt(previous.updatedAt, expectedUpdatedAt, '银充订单');
    if (
      previous.source === 'automatic' &&
      !online &&
      (input.chargeAmount !== undefined ||
        input.chargeCurrencyCode !== undefined ||
        input.plan !== undefined)
    ) {
      throw new ConflictException('官网代付事实不能修改');
    }
    if (input.paymentEvidenceRef !== undefined && typeof input.paymentEvidenceRef !== 'string')
      throw new BadRequestException('实付凭据编号格式无效');
    let onlineSnapshot = onlineOrderSnapshot(previous.onlineSourceSnapshot);
    if (online && previous.source === 'automatic') {
      if (input.plan !== undefined && input.plan !== previous.plan)
        throw new ConflictException('官网套餐事实不能修改');
      const changingAmount =
        input.chargeAmount !== undefined &&
        (previous.chargeAmount === null ||
          !bankRechargeMoney(input.chargeAmount, '代付金额').equals(previous.chargeAmount));
      const changingCurrency =
        input.chargeCurrencyCode !== undefined &&
        input.chargeCurrencyCode !== previous.chargeCurrencyCode;
      if (
        (changingAmount && previous.chargeAmount !== null) ||
        (changingCurrency && previous.chargeCurrencyCode !== null)
      )
        throw new ConflictException('已核实的官网代付事实不能修改');
      if (
        changingAmount ||
        changingCurrency ||
        (typeof input.paymentEvidenceRef === 'string' && input.paymentEvidenceRef.trim())
      ) {
        const ref = bankRechargeText(input.paymentEvidenceRef, '实付金额人工核验凭据编号', 220);
        if (/[:/]/.test(ref) || /(?:token|cookie|session|password)[= ]/i.test(ref))
          throw new BadRequestException('请只填写付款凭据编号，不填写网址或登录资料');
        if (previous.manualEvidenceRef && previous.manualEvidenceRef !== ref)
          throw new ConflictException('已核实的人工付款凭据不能改写');
        if (await this.repository.findOtherOrderByPaymentReference(tx, ref, previous.id))
          throw new ConflictException('该付款凭据已关联其他充值订单');
        onlineSnapshot = {
          ...onlineSnapshot,
          manualAmountEvidenceRef: ref,
          manualAmountVerifiedBy: operator.id
        };
      }
    }
    if (
      previous.source === 'automatic' &&
      ['openedAt', 'dueAt'].some((key) => {
        if (input[key] === undefined) return false;
        const prior = key === 'openedAt' ? previous.openedAt : previous.dueAt;
        if (input[key] === null) return prior !== null;
        return (
          bankRechargeDate(input[key], key === 'openedAt' ? '开通时间' : '到期时间').getTime() !==
          prior?.getTime()
        );
      })
    ) {
      throw new ConflictException('自动付款日期须通过核对订阅操作确认，不能在普通编辑中推定');
    }
    const currencyCode =
      input.chargeCurrencyCode === undefined
        ? previous.chargeCurrencyCode
        : bankRechargeCurrency(input.chargeCurrencyCode);
    const currency = currencyCode ? await this.accounts.requireCurrency(tx, currencyCode) : null;
    const charge =
      input.chargeAmount === undefined
        ? previous.chargeAmount === null
          ? null
          : Amount4.from(previous.chargeAmount)
        : bankRechargeMoney(
            input.chargeAmount,
            '代付金额',
            currency?.minorUnits ?? 4,
            !(online && onlineSnapshot.zeroAmountChange === true)
          );
    if (!online && (!currency || !charge)) throw new BadRequestException('请填写代付金额和币种');
    if (charge && currency)
      bankRechargeMoney(
        charge.toString(),
        '代付金额',
        currency.minorUnits,
        !(online && onlineSnapshot.zeroAmountChange === true)
      );
    if (input.chargeAmount !== undefined && !currency)
      throw new BadRequestException('请先填写代付币种');
    const accountId =
      input.accountId === undefined
        ? previous.accountId
        : bankRechargeOptionalId(input.accountId, 'ChatGPT 账号');
    if (previous.accountId && previous.openedAt && accountId !== previous.accountId) {
      throw new ConflictException('已开通订单不能更换 ChatGPT 账号');
    }
    const customerId =
      input.customerId === undefined
        ? previous.customerId
        : bankRechargeOptionalId(input.customerId, '客户');
    const cardId =
      (online ? input.onlineRechargeCardId : input.cardId) === undefined
        ? online
          ? previous.onlineRechargeCardId
          : previous.cardId
        : bankRechargeOptionalId(online ? input.onlineRechargeCardId : input.cardId, '银行卡');
    if (accountId) {
      const account = await this.accounts.requireActive(tx, accountId);
      if (previous.source === 'automatic') {
        const source = previous.rechargeJobId
          ? await this.repository.findRechargeJob(tx, previous.rechargeJobId)
          : null;
        const sourceKey = online ? bankRechargePaymentAccountKey(previous) : source?.accountKey;
        if (!sourceKey || account.officialAccountKey !== sourceKey) {
          throw new ConflictException('所选账号与原官网付款身份不一致，请先核验账号归属');
        }
      }
    }
    if (customerId) await this.requireCustomer(tx, customerId);
    const card = cardId && !online && currencyCode ? await this.requireCard(tx, cardId) : null;
    const originalOnlineCardId =
      typeof onlineSnapshot.originalCardId === 'string'
        ? onlineSnapshot.originalCardId
        : previous.onlineRechargeCardId;
    if (online && previous.source === 'automatic') {
      if (originalOnlineCardId && cardId !== originalOnlineCardId)
        throw new ConflictException('线上原付款银行卡不能更换，即使尾号相同也不能替代');
      if (!originalOnlineCardId && cardId && cardId !== previous.onlineRechargeCardId) {
        const cardEvidence = bankRechargeText(
          input.paymentEvidenceRef,
          '原付款银行卡核验凭据编号',
          220
        );
        if (/[:/]/.test(cardEvidence)) throw new BadRequestException('请只填写付款凭据编号');
        onlineSnapshot = {
          ...onlineSnapshot,
          manualVerifiedCardId: cardId,
          manualCardEvidenceRef: cardEvidence
        };
      }
    }
    const onlineCard =
      cardId && online
        ? await this.requireOnlineCard(
            tx,
            cardId,
            previous.onlineRechargeCardId === cardId ||
              (previous.source === 'automatic' &&
                (originalOnlineCardId === cardId ||
                  (onlineSnapshot.manualVerifiedCardId === cardId &&
                    Boolean(onlineSnapshot.manualCardEvidenceRef))))
          )
        : null;
    if (
      previous.source === 'automatic' &&
      previous.cardLast4 &&
      (card || onlineCard) &&
      previous.cardLast4 !== (card?.last4 ?? onlineCard?.last4)
    ) {
      throw new ConflictException('所选银行卡尾号与官网付款凭据不一致');
    }
    const newFees =
      previous.accountingVersion === 'subscription_cost_v2' || input.confirmFeeConversion === true;
    if (
      newFees &&
      [
        'customerFeeRate',
        'customerFeeAmount',
        'bankFeeAmount',
        'bankFeeCurrencyCode',
        'bankFeeFxRateToCny'
      ].some((key) => input[key] !== undefined)
    )
      throw new BadRequestException('新版订阅订单只接受 USDT 手续费和购物网手续费');
    if (
      input.confirmFeeConversion === true &&
      (input.usdtFeeAmount === undefined ||
        input.usdtFeeAmount === null ||
        input.usdtFeeAmount === '' ||
        input.shoppingFeeAmount === undefined ||
        input.shoppingFeeAmount === null ||
        input.shoppingFeeAmount === '')
    )
      throw new BadRequestException('转换旧口径前请重新核对两项手续费');
    if (
      !newFees &&
      BANK_RECHARGE_FEE_PREFIXES.some((prefix) =>
        Object.keys(input).some((key) => key.startsWith(prefix))
      )
    )
      throw new BadRequestException('旧口径订单需明确确认转换后再填写新费用');
    const feeData = newFees ? await this.fees.prepare(tx, previous, input, operator, context) : {};
    const rate =
      input.customerFeeRate === undefined
        ? Amount4.from(previous.customerFeeRate)
        : bankRechargeFeeRate(input.customerFeeRate);
    const manualFee =
      input.customerFeeAmount !== undefined && input.customerFeeAmount !== null
        ? bankRechargeMoney(input.customerFeeAmount, '客户手续费', currency?.minorUnits ?? 4)
        : null;
    const feeOverridden =
      manualFee !== null
        ? true
        : input.customerFeeAmount === null
          ? false
          : previous.customerFeeOverridden;
    const fee =
      manualFee ??
      (feeOverridden
        ? Amount4.from(previous.customerFeeAmount)
        : charge
          ? bankRechargeFee(charge, rate, currency?.minorUnits ?? 4)
          : Amount4.zero());
    const openedAt =
      input.openedAt === undefined
        ? previous.openedAt
        : input.openedAt === null
          ? null
          : bankRechargeDate(input.openedAt, '开通时间');
    const dueAt =
      input.dueAt === undefined
        ? (previous.dueAt ??
          (previous.source === 'manual' && !online && openedAt
            ? bankRechargeDefaultDueAt(openedAt)
            : null))
        : input.dueAt === null
          ? previous.source === 'manual' && !online && openedAt
            ? bankRechargeDefaultDueAt(openedAt)
            : null
          : bankRechargeDate(input.dueAt, '到期时间');
    this.assertDates(openedAt, dueAt);
    const bankFeeCurrencyCode =
      input.bankFeeCurrencyCode === undefined
        ? previous.bankFeeCurrencyCode
        : input.bankFeeCurrencyCode === null
          ? null
          : bankRechargeCurrency(input.bankFeeCurrencyCode);
    const bankFeeCurrency = bankFeeCurrencyCode
      ? await this.accounts.requireCurrency(tx, bankFeeCurrencyCode)
      : null;
    const bankFee =
      input.bankFeeAmount === undefined
        ? (previous.bankFeeAmount?.toString() ?? null)
        : input.bankFeeAmount === null
          ? null
          : bankRechargeMoney(
              input.bankFeeAmount,
              '银行手续费',
              bankFeeCurrency?.minorUnits ?? 4
            ).toString();
    if (bankFee && !bankFeeCurrency) throw new BadRequestException('请设置银行手续费币种');
    const receivedCurrencyCode =
      input.receivedCurrencyCode === undefined
        ? previous.receivedCurrencyCode
        : input.receivedCurrencyCode === null
          ? null
          : bankRechargeCurrency(input.receivedCurrencyCode);
    const received =
      input.receivedAmount === undefined
        ? (previous.receivedAmount?.toString() ?? null)
        : input.receivedAmount === null
          ? null
          : bankRechargeMoney(input.receivedAmount, '客户实收金额', 4).toString();
    if (received && !receivedCurrencyCode) throw new BadRequestException('请设置客户实收币种');
    const chargeFxRateToCny = bankRechargeFxRate(
      input.chargeFxRateToCny,
      previous.chargeFxRateToCny,
      '代付汇率',
      currencyCode
    );
    const bankFeeFxRateToCny = bankRechargeFxRate(
      input.bankFeeFxRateToCny,
      previous.bankFeeFxRateToCny,
      '银行手续费汇率',
      bankFeeCurrencyCode
    );
    const receivedFxRateToCny = bankRechargeFxRate(
      input.receivedFxRateToCny,
      previous.receivedFxRateToCny,
      '实收汇率',
      receivedCurrencyCode
    );
    const fundingFinanceAccountId =
      input.fundingFinanceAccountId === undefined
        ? previous.fundingFinanceAccountId
        : bankRechargeOptionalId(input.fundingFinanceAccountId, '代付资金账户');
    const receivedFinanceAccountId =
      input.receivedFinanceAccountId === undefined
        ? previous.receivedFinanceAccountId
        : bankRechargeOptionalId(input.receivedFinanceAccountId, '客户收款账户');
    const updated = await this.repository.updateOrder(tx, {
      where: { id },
      data: {
        accountId,
        customerId,
        cardId: online ? null : cardId,
        onlineRechargeCardId: online ? cardId : null,
        ...(online
          ? {
              onlineSourceSnapshot: toV2JsonDocument(onlineSnapshot),
              ...(typeof onlineSnapshot.manualAmountEvidenceRef === 'string'
                ? { manualEvidenceRef: onlineSnapshot.manualAmountEvidenceRef }
                : {})
            }
          : {}),
        cardLast4: onlineCard?.last4 ?? card?.last4 ?? previous.cardLast4,
        ...(!online && cardId !== previous.cardId
          ? bankRechargeCardSnapshot(this.encryption, card)
          : {}),
        ...(onlineCard && cardId !== previous.onlineRechargeCardId
          ? { cardLabelSnapshot: `线上银行卡 ····${onlineCard.last4}` }
          : {}),
        plan: input.plan === undefined ? previous.plan : this.plan(input.plan),
        chargeAmount: charge?.toString() ?? null,
        chargeCurrencyCode: currencyCode,
        ...(newFees ? { accountingVersion: 'subscription_cost_v2' as const, ...feeData } : {}),
        customerFeeRate: rate.toString(),
        customerFeeAmount: fee.toString(),
        customerFeeOverridden: feeOverridden,
        bankFeeAmount: bankFee,
        bankFeeCurrencyCode,
        receivedAmount: received,
        receivedCurrencyCode,
        chargeFxRateToCny,
        bankFeeFxRateToCny,
        receivedFxRateToCny,
        fundingFinanceAccountId,
        receivedFinanceAccountId,
        openedAt,
        dueAt,
        remark:
          input.remark === undefined
            ? previous.remark
            : bankRechargeText(input.remark, '备注', 2000, false) || null,
        updatedByUserId: operator.id
      }
    });
    if (accountId && openedAt) {
      await activateBankRechargeSubscription(tx, this.repository, updated);
    } else if (previous.accountId) {
      await this.repository.cancelSubscriptionForOrder(tx, previous.accountId, id);
    }
    await this.audit.append(tx, {
      userId: operator.id,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.order.update',
      objectType: 'bank_recharge_order',
      objectId: id,
      beforeData: bankRechargeOrderAuditSnapshot(previous),
      afterData: bankRechargeOrderAuditSnapshot(updated),
      remark: '补全或调整银充订单资料'
    });
    return updated;
  }

  async recordVerifiedSuccess(
    tx: V2CommandTransaction,
    job: IdBusinessV2RechargeJob,
    result: Record<string, unknown>
  ) {
    return recordVerifiedBankRechargeOrder(tx, job, result, {
      accounts: this.accounts,
      repository: this.repository,
      audit: this.audit,
      encryption: this.encryption,
      orderNo: () => this.orderNo()
    });
  }

  private async requireCustomer(tx: V2CommandTransaction, id: string) {
    const customer = await this.repository.findCustomer(tx, id);
    if (!customer || customer.deletedAt || customer.recordStatus !== 'active') {
      throw new BadRequestException('客户不存在或已停用');
    }
    return customer;
  }

  private async requireOnlineCard(tx: V2CommandTransaction, id: string, allowExhausted = false) {
    const card = await this.repository.findOnlineCard(tx, id);
    if (!card || (card.status !== 'active' && !(allowExhausted && card.status === 'exhausted')))
      throw new BadRequestException('线上银行卡不存在、已停用或不能用于当前订单');
    return card;
  }

  private async requireCard(tx: V2CommandTransaction, id: string) {
    const card = await this.repository.findCard(tx, id);
    if (!card || !card.active) {
      throw new BadRequestException('银行卡不存在或已停用');
    }
    return card;
  }

  private plan(value: unknown) {
    if (typeof value !== 'string' || !plans.has(value)) {
      throw new BadRequestException('ChatGPT 套餐无效');
    }
    return value;
  }

  private assertDates(openedAt: Date | null, dueAt: Date | null) {
    if (dueAt && (!openedAt || dueAt <= openedAt)) {
      throw new BadRequestException('到期时间必须晚于开通时间');
    }
  }

  private orderNo() {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 14);
    return `BC${timestamp}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }
}
