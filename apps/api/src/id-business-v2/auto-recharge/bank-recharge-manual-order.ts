import { activateBankRechargeSubscription } from './bank-recharge-subscription-projection';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { bankRechargeDefaultDueAt } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { bankRechargeCardSnapshot } from './bank-recharge-card-summary';
import { assertBankRechargeChannelAccess, bankRechargeOrderChannel } from './bank-recharge-channel';
import {
  bankRechargeObject,
  bankRechargeOptionalId,
  bankRechargeCurrency,
  bankRechargeText,
  bankRechargeMoney,
  bankRechargeDate
} from './bank-recharge-validation';
interface ManualOrderDependencies {
  transactions: V2CommandTransactionManager;
  audit: V2TransactionalAuditService;
  accounts: BankRechargeAccountService;
  repository: BankRechargeRepository;
  encryption: FieldEncryptionService;
  requireCustomer: (tx: V2CommandTransaction, id: string) => Promise<unknown>;
  requireCard: (
    tx: V2CommandTransaction,
    id: string,
    currency: string
  ) => Promise<Awaited<ReturnType<BankRechargeRepository['findCard']>>>;
  requireOnlineCard: (
    tx: V2CommandTransaction,
    id: string
  ) => Promise<Awaited<ReturnType<BankRechargeRepository['findOnlineCard']>>>;
  plan: (value: unknown) => string;
  orderNo: () => string;
  assertDates: (openedAt: Date | null, dueAt: Date | null) => void;
}
export async function createManualBankRechargeOrder(
  value: unknown,
  operator: AuthenticatedUser,
  deps: ManualOrderDependencies
) {
  const input = bankRechargeObject(value);
  const channel = bankRechargeOrderChannel(input.channel);
  assertBankRechargeChannelAccess(channel, operator, true);
  if (channel === 'online' ? Boolean(input.cardId) : Boolean(input.onlineRechargeCardId))
    throw new BadRequestException('银行卡必须属于当前订单渠道');
  const accountId = bankRechargeOptionalId(input.accountId, 'ChatGPT 账号');
  const customerId = bankRechargeOptionalId(input.customerId, '客户');
  const cardId = bankRechargeOptionalId(
    channel === 'online' ? input.onlineRechargeCardId : input.cardId,
    '银行卡'
  );
  const plan = deps.plan(input.plan);
  const currencyCode =
    channel === 'online' &&
    (input.chargeCurrencyCode === undefined ||
      input.chargeCurrencyCode === null ||
      input.chargeCurrencyCode === '')
      ? null
      : bankRechargeCurrency(input.chargeCurrencyCode);
  const evidence = bankRechargeText(input.manualEvidenceRef, '手工付款凭据编号', 220);
  if (
    channel === 'online' &&
    (/[:/]/.test(evidence) || /(?:token|cookie|session|password)[= ]/i.test(evidence))
  )
    throw new BadRequestException('请只填写付款凭据编号，不填写网址或登录资料');
  const remark = bankRechargeText(input.remark, '备注', 2000, false);
  return deps.transactions.execute(
    async (tx) => {
      if (await deps.repository.findOtherOrderByPaymentReference(tx, evidence))
        throw new BadRequestException('该付款凭据已关联其他充值订单');
      const currency = currencyCode ? await deps.accounts.requireCurrency(tx, currencyCode) : null;
      const charge =
        channel === 'online' &&
        (input.chargeAmount === undefined ||
          input.chargeAmount === null ||
          input.chargeAmount === '')
          ? null
          : bankRechargeMoney(input.chargeAmount, '代付金额', currency?.minorUnits ?? 4, true);
      if (charge && !currency) throw new BadRequestException('请填写代付币种');
      if (accountId) await deps.accounts.requireActive(tx, accountId);
      if (customerId) await deps.requireCustomer(tx, customerId);
      const card =
        cardId && channel === 'bitbrowser'
          ? await deps.requireCard(tx, cardId, currencyCode!)
          : null;
      const onlineCard =
        cardId && channel === 'online' ? await deps.requireOnlineCard(tx, cardId) : null;
      const openedAt = input.openedAt
        ? bankRechargeDate(input.openedAt, '开通时间')
        : channel === 'online'
          ? null
          : new Date();
      const dueAt = input.dueAt
        ? bankRechargeDate(input.dueAt, '到期时间')
        : channel === 'bitbrowser' && openedAt
          ? bankRechargeDefaultDueAt(openedAt)
          : null;
      deps.assertDates(openedAt, dueAt);
      const item = await deps.repository.createOrder(tx, {
        data: {
          orderNo: deps.orderNo(),
          channel,
          source: 'manual',
          manualEvidenceRef: evidence,
          accountId,
          customerId,
          cardId: channel === 'bitbrowser' ? cardId : null,
          onlineRechargeCardId: channel === 'online' ? cardId : null,
          cardLast4: onlineCard?.last4 ?? card?.last4 ?? null,
          ...bankRechargeCardSnapshot(deps.encryption, card),
          ...(onlineCard ? { cardLabelSnapshot: `线上银行卡 ····${onlineCard.last4}` } : {}),
          plan,
          chargeAmount: charge?.toString() ?? null,
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
      if (accountId && openedAt) await activateBankRechargeSubscription(tx, deps.repository, item);
      await deps.audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.bank_recharge.order.create_manual',
        objectType: 'bank_recharge_order',
        objectId: item.id,
        afterData: {
          orderNo: item.orderNo,
          channel,
          accountId,
          customerId,
          cardId,
          plan,
          chargeAmount: charge?.toString() ?? null,
          chargeCurrencyCode: currencyCode,
          manualEvidenceRef: evidence
        },
        remark: '新建手工充值订单，待补齐资料和财务确认'
      });
      return item;
    },
    {
      changedScopes: ['auto-recharge', 'online-recharge', 'renewals', 'renewal-warning-summary'],
      requestId: randomUUID(),
      operator,
      retryMode: 'none',
      uniqueConflictMessage: '该手工付款凭据已关联充值订单'
    }
  );
}
