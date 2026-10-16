import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  Amount4,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { bankRechargeCardSnapshot } from './bank-recharge-card-summary';
import { resolveBankRechargeSource } from './bank-recharge-recheck';
import {
  hasVerifiedRechargePayment,
  isRechargeUpgrade,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';
import { bankRechargeCurrency, bankRechargeMoney } from './bank-recharge-validation';
type SuccessEvidence = { kind: string; identifier: string; amount_minor: number; currency: string };
export async function recordVerifiedBankRechargeOrder(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  result: Record<string, unknown>,
  deps: {
    accounts: BankRechargeAccountService;
    repository: BankRechargeRepository;
    audit: V2TransactionalAuditService;
    encryption: FieldEncryptionService;
    orderNo: () => string;
  }
) {
  const verifiedSource = await resolveBankRechargeSource(tx, deps.repository, job, result);
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
    const account = await deps.accounts.requireActive(tx, job.chatgptAccountId);
    if (account.officialAccountKey !== job.accountKey) return null;
  }
  const prior = await deps.repository.findOrderByPaymentEvidence(
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
      prior.chargeAmount?.toString() !== Amount4.from(quote.today.amount).toString()
    ) {
      throw new ConflictException('官网付款证据已关联其他银充订单');
    }
    return prior;
  }
  const currencyCode = bankRechargeCurrency(quote.today.currency);
  const currency = await deps.accounts.ensureVerifiedCurrency(
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
    ? await deps.repository.findCardsByTail(tx, cardLast4, job.cardId)
    : [];
  const card = job.cardId
    ? (matchingCards.find((candidate) => candidate.id === job.cardId) ?? null)
    : matchingCards.length === 1
      ? matchingCards[0]!
      : null;
  const verifiedAt = new Date();
  const accountId = await deps.accounts.ensureAccountForVerifiedPayment(tx, job);
  // 核验时刻和官网旧账期均不代表本次实际付款时间，先保留待人工核对。
  const item = await deps.repository.createOrder(tx, {
    data: {
      orderNo: deps.orderNo(),
      source: 'automatic',
      rechargeJobId: job.id,
      checkoutIdentifier,
      paymentEvidenceId: evidence.identifier,
      accountId,
      customerId: null,
      cardId: card?.id ?? null,
      ...bankRechargeCardSnapshot(deps.encryption, card),
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
  await deps.audit.append(tx, {
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
