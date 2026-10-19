import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import type { BankRechargeRepository } from './persistence/bank-recharge.repository';
import type { BankRechargeAccountService } from './bank-recharge-account.service';
import {
  bankRechargeCurrency,
  bankRechargeDate,
  bankRechargeMoney
} from './bank-recharge-validation';
import { bankRechargeCardSnapshot } from './bank-recharge-card-summary';
import { activateBankRechargeSubscription } from './bank-recharge-subscription-projection';

export async function recordManuallySettledRecharge(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  input: {
    identifier: string;
    evidenceRef: string;
    amount: string;
    currency: string;
    openedAt: string;
    dueAt: string;
  },
  deps: {
    repository: BankRechargeRepository;
    accounts: BankRechargeAccountService;
    encryption: FieldEncryptionService;
    audit: V2TransactionalAuditService;
    orderNo: () => string;
  }
) {
  const previous = await deps.repository.findOrderByPaymentEvidence(
    tx,
    job.id,
    input.identifier,
    input.evidenceRef
  );
  if (previous)
    throw new ConflictException('该任务、原单或付款凭据已有充值订单，请在原订单处理，不能重复记账');
  const currency = await deps.accounts.requireCurrency(tx, bankRechargeCurrency(input.currency));
  const amount = bankRechargeMoney(input.amount, '实际付款金额', currency.minorUnits, true);
  const openedAt = bankRechargeDate(input.openedAt, '实际开通时间'),
    dueAt = bankRechargeDate(input.dueAt, '实际到期时间');
  if (openedAt > new Date() || dueAt <= openedAt) throw new ConflictException('开通和到期时间无效');
  const accountId = await deps.accounts.ensureAccountForVerifiedPayment(tx, job);
  if (!accountId) throw new ConflictException('原账号未绑定系统账号，请先核对账号资料');
  const card = job.cardId ? await deps.repository.findCard(tx, job.cardId) : null;
  if (!card) throw new ConflictException('原充值银行卡资料不存在，不能创建成功订单');
  const order = await deps.repository.createOrder(tx, {
    data: {
      orderNo: deps.orderNo(),
      channel: 'bitbrowser',
      source: 'manual',
      rechargeJobId: job.id,
      checkoutIdentifier: input.identifier,
      manualEvidenceRef: input.evidenceRef,
      accountId,
      cardId: card?.id ?? null,
      ...bankRechargeCardSnapshot(deps.encryption, card),
      cardLast4: card?.last4 ?? null,
      plan: job.plan,
      chargeAmount: amount.toString(),
      chargeCurrencyCode: currency.code,
      accountingVersion: 'subscription_cost_v2',
      customerFeeRate: '0',
      customerFeeAmount: '0',
      openedAt,
      dueAt,
      remark: '原充值任务由操作人核对付款和订阅后人工结单；待补全客户、手续费及财务资料',
      createdByUserId: job.ownerId,
      updatedByUserId: job.ownerId
    }
  });
  await activateBankRechargeSubscription(tx, deps.repository, order);
  await deps.audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.bank_recharge.order.create_from_manual_settlement',
    objectType: 'bank_recharge_order',
    objectId: order.id,
    afterData: {
      rechargeJobId: job.id,
      orderNo: order.orderNo,
      amount: amount.toString(),
      currency: currency.code
    },
    remark: '人工核实充值成功，关联原任务创建手工充值订单，进入既有记账流程'
  });
  return order;
}
