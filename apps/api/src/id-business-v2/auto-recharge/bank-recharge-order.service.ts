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
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { bankRechargeCardSnapshot } from './bank-recharge-card-summary';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { resolveBankRechargeSource } from './bank-recharge-recheck';
import { activateBankRechargeSubscription } from './bank-recharge-subscription-projection';
import {
  hasVerifiedRechargePayment,
  isRechargeUpgrade,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';
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

type SuccessEvidence = { kind: string; identifier: string; amount_minor: number; currency: string };

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
    const input = bankRechargeObject(value);
    const accountId = bankRechargeOptionalId(input.accountId, 'ChatGPT 账号');
    const customerId = bankRechargeOptionalId(input.customerId, '客户');
    const cardId = bankRechargeOptionalId(input.cardId, '银行卡');
    const plan = this.plan(input.plan);
    const currencyCode = bankRechargeCurrency(input.chargeCurrencyCode);
    const evidence = bankRechargeText(input.manualEvidenceRef, '手工付款凭据编号', 220);
    const remark = bankRechargeText(input.remark, '备注', 2000, false);
    return this.transactions.execute(
      async (tx) => {
        const currency = await this.accounts.requireCurrency(tx, currencyCode);
        const charge = bankRechargeMoney(input.chargeAmount, '代付金额', currency.minorUnits, true);
        if (accountId) await this.accounts.requireActive(tx, accountId);
        if (customerId) await this.requireCustomer(tx, customerId);
        const card = cardId ? await this.requireCard(tx, cardId, currencyCode) : null;
        const openedAt = input.openedAt ? bankRechargeDate(input.openedAt, '开通时间') : new Date();
        const dueAt = input.dueAt
          ? bankRechargeDate(input.dueAt, '到期时间')
          : bankRechargeDefaultDueAt(openedAt);
        this.assertDates(openedAt, dueAt);
        const item = await this.repository.createOrder(tx, {
          data: {
            orderNo: this.orderNo(),
            source: 'manual',
            manualEvidenceRef: evidence,
            accountId,
            customerId,
            cardId,
            cardLast4: card?.last4 ?? null,
            ...bankRechargeCardSnapshot(this.encryption, card),
            plan,
            chargeAmount: charge.toString(),
            chargeCurrencyCode: currencyCode,
            accountingVersion: 'subscription_cost_v2',
            customerFeeRate: '0',
            customerFeeAmount: '0',
            openedAt,
            dueAt,
            remark: remark || null,
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          }
        });
        if (accountId && openedAt)
          await activateBankRechargeSubscription(tx, this.repository, item);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.order.create_manual',
          objectType: 'bank_recharge_order',
          objectId: item.id,
          afterData: {
            orderNo: item.orderNo,
            accountId,
            customerId,
            cardId,
            plan,
            chargeAmount: charge.toString(),
            chargeCurrencyCode: currencyCode,
            manualEvidenceRef: evidence
          },
          remark: '新建手工银充订单，待补齐资料和财务确认'
        });
        return item;
      },
      {
        changedScopes: ['auto-recharge', 'renewals', 'renewal-warning-summary'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该手工付款凭据已关联银充订单'
      }
    );
  }

  async update(id: string, value: unknown, operator: AuthenticatedUser) {
    return this.transactions.execute((tx) => this.updateInTransaction(tx, id, value, operator), {
      changedScopes: ['auto-recharge', 'renewals', 'renewal-warning-summary', 'dashboard'],
      requestId: randomUUID(),
      operator,
      retryMode: 'none'
    });
  }

  async updateInTransaction(
    tx: V2CommandTransaction,
    id: string,
    value: unknown,
    operator: AuthenticatedUser
  ) {
    bankRechargeId(id, '银充订单');
    const input = bankRechargeObject(value);
    if (Object.keys(input).some((key) => !editable.has(key))) {
      throw new BadRequestException('银充订单包含不可修改字段');
    }
    const expectedUpdatedAt = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银充订单');

    const previous = await this.repository.findOrder(tx, id);
    if (!previous) throw new NotFoundException('银充订单不存在');
    if (['completed', 'refunded', 'cancelled'].includes(previous.status)) {
      throw new ConflictException('已完成或已结束的银充订单不能直接改写，请走更正或退款流程');
    }
    assertV2ExpectedUpdatedAt(previous.updatedAt, expectedUpdatedAt, '银充订单');
    if (
      previous.source === 'automatic' &&
      (input.chargeAmount !== undefined ||
        input.chargeCurrencyCode !== undefined ||
        input.plan !== undefined)
    ) {
      throw new ConflictException('官网代付事实不能修改');
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
    const currency = await this.accounts.requireCurrency(tx, currencyCode);
    const charge =
      input.chargeAmount === undefined
        ? Amount4.from(previous.chargeAmount)
        : bankRechargeMoney(input.chargeAmount, '代付金额', currency.minorUnits, true);
    if (input.chargeAmount === undefined) {
      bankRechargeMoney(charge.toString(), '代付金额', currency.minorUnits, true);
    }
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
      input.cardId === undefined ? previous.cardId : bankRechargeOptionalId(input.cardId, '银行卡');
    if (accountId) {
      const account = await this.accounts.requireActive(tx, accountId);
      if (previous.source === 'automatic') {
        const source = previous.rechargeJobId
          ? await this.repository.findRechargeJob(tx, previous.rechargeJobId)
          : null;
        if (!source?.accountKey || account.officialAccountKey !== source.accountKey) {
          throw new ConflictException('所选账号与原官网付款身份不一致，请先核验账号归属');
        }
      }
    }
    if (customerId) await this.requireCustomer(tx, customerId);
    const card = cardId ? await this.requireCard(tx, cardId, currencyCode) : null;
    if (
      previous.source === 'automatic' &&
      previous.cardLast4 &&
      card &&
      previous.cardLast4 !== card.last4
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
    const feeData = newFees ? await this.fees.prepare(tx, previous, input, operator) : {};
    const rate =
      input.customerFeeRate === undefined
        ? Amount4.from(previous.customerFeeRate)
        : bankRechargeFeeRate(input.customerFeeRate);
    const manualFee =
      input.customerFeeAmount !== undefined && input.customerFeeAmount !== null
        ? bankRechargeMoney(input.customerFeeAmount, '客户手续费', currency.minorUnits)
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
        : bankRechargeFee(charge, rate, currency.minorUnits));
    const openedAt =
      input.openedAt === undefined
        ? previous.openedAt
        : input.openedAt === null
          ? null
          : bankRechargeDate(input.openedAt, '开通时间');
    const dueAt =
      input.dueAt === undefined
        ? (previous.dueAt ??
          (previous.source === 'manual' && openedAt ? bankRechargeDefaultDueAt(openedAt) : null))
        : input.dueAt === null
          ? previous.source === 'manual' && openedAt
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
        cardId,
        cardLast4: card?.last4 ?? previous.cardLast4,
        ...(cardId !== previous.cardId ? bankRechargeCardSnapshot(this.encryption, card) : {}),
        plan: input.plan === undefined ? previous.plan : this.plan(input.plan),
        chargeAmount: charge.toString(),
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
    const verifiedSource = await resolveBankRechargeSource(tx, this.repository, job, result);
    if (!verifiedSource) return null;
    ({ job, result } = verifiedSource);
    if (!hasVerifiedRechargePayment(result, job)) return null;
    const evidence = result.payment_evidence as SuccessEvidence | undefined;
    const quote = result.quote as
      | { today?: { amount?: string; amount_minor?: number; currency?: string } }
      | undefined;
    const checkoutIdentifier = isRechargeUpgrade(result)
      ? rechargeUpgradePaymentReference(result)
      : result.checkout_identifier;
    if (
      !evidence ||
      !quote?.today ||
      typeof checkoutIdentifier !== 'string' ||
      !checkoutIdentifier ||
      typeof evidence.identifier !== 'string' ||
      !evidence.identifier ||
      !Number.isSafeInteger(evidence.amount_minor) ||
      evidence.amount_minor !== quote.today.amount_minor ||
      evidence.currency !== quote.today.currency ||
      typeof quote.today.amount !== 'string'
    )
      return null;
    if (job.chatgptAccountId) {
      const account = await this.accounts.requireActive(tx, job.chatgptAccountId);
      if (account.officialAccountKey !== job.accountKey) return null;
    }
    const prior = await this.repository.findOrderByPaymentEvidence(
      tx,
      job.id,
      checkoutIdentifier,
      evidence.identifier
    );
    if (prior) {
      if (
        prior.rechargeJobId !== job.id ||
        prior.checkoutIdentifier !== checkoutIdentifier ||
        prior.paymentEvidenceId !== evidence.identifier ||
        prior.chargeCurrencyCode !== quote.today.currency ||
        prior.chargeAmount.toString() !== Amount4.from(quote.today.amount).toString()
      ) {
        throw new ConflictException('官网付款证据已关联其他银充订单');
      }
      return prior;
    }
    const currencyCode = bankRechargeCurrency(quote.today.currency);
    const currency = await this.accounts.ensureVerifiedCurrency(
      tx,
      currencyCode,
      quote.today.amount.split('.')[1]?.length ?? 0
    );
    const charge = bankRechargeMoney(quote.today.amount, '官网代付金额', currency.minorUnits, true);
    if (!charge.mul(`1${'0'.repeat(currency.minorUnits)}`).equals(String(evidence.amount_minor))) {
      return null;
    }
    const cardLast4 =
      typeof result.card_last4 === 'string' && /^\d{4}$/.test(result.card_last4)
        ? result.card_last4
        : null;
    const matchingCards = cardLast4
      ? await this.repository.findCardsByTail(tx, cardLast4, currencyCode)
      : [];
    const card = job.cardId
      ? (matchingCards.find((candidate) => candidate.id === job.cardId) ?? null)
      : matchingCards.length === 1
        ? matchingCards[0]!
        : null;
    const verifiedAt = new Date();
    const accountId = await this.accounts.ensureAccountForVerifiedPayment(tx, job);
    // 核验时刻和官网旧账期均不代表本次实际付款时间，先保留待人工核对。
    const item = await this.repository.createOrder(tx, {
      data: {
        orderNo: this.orderNo(),
        source: 'automatic',
        rechargeJobId: job.id,
        checkoutIdentifier,
        paymentEvidenceId: evidence.identifier,
        accountId,
        customerId: null,
        cardId: card?.id ?? null,
        ...bankRechargeCardSnapshot(this.encryption, card),
        cardLast4,
        plan: job.plan,
        chargeAmount: charge.toString(),
        chargeCurrencyCode: currencyCode,
        accountingVersion: 'subscription_cost_v2',
        customerFeeRate: '0',
        customerFeeAmount: '0',
        openedAt: null,
        verifiedAt,
        dueAt: null,
        renewedFromOrderId: null,
        createdByUserId: job.ownerId,
        updatedByUserId: job.ownerId
      }
    });
    await this.audit.append(tx, {
      userId: job.ownerId,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.order.create_from_verified_payment',
      objectType: 'bank_recharge_order',
      objectId: item.id,
      afterData: {
        orderNo: item.orderNo,
        rechargeJobId: job.id,
        checkoutIdentifier,
        paymentEvidenceId: evidence.identifier,
        chargeAmount: charge.toString(),
        chargeCurrencyCode: currencyCode,
        accountId,
        status: item.status
      },
      remark: '官网付款和订阅生效均核实，自动生成待补全银充订单'
    });
    return item;
  }

  private async requireCustomer(tx: V2CommandTransaction, id: string) {
    const customer = await this.repository.findCustomer(tx, id);
    if (!customer || customer.deletedAt || customer.recordStatus !== 'active') {
      throw new BadRequestException('客户不存在或已停用');
    }
    return customer;
  }

  private async requireCard(tx: V2CommandTransaction, id: string, currencyCode: string) {
    const card = await this.repository.findCard(tx, id);
    if (!card || !card.active || card.currencyCode !== currencyCode) {
      throw new BadRequestException('银行卡不存在、已停用或币种不一致');
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
