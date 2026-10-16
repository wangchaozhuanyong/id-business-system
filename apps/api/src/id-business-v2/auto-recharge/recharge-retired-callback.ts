import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import type { RechargeAddressRepository } from './persistence/recharge-address.repository';
import type { BankRechargeOrderService } from './bank-recharge-order.service';
import type { BankRechargeCardService } from './bank-recharge-card.service';
import type { RechargeNameService } from './recharge-name.service';
import { hash, object, safeDocument } from './recharge-validation';
import { hasOfficialRechargeQuote, rechargeOperationIdentifier } from './recharge-upgrade-protocol';
import { mergeRechargePaymentFacts, projectRechargePaymentRecord } from './recharge-payment-facts';
import { recordVerifiedBankRecharge } from './recharge-bank-callback';
import { consumeRechargeAddress } from './recharge-address-consumption';
import { finalizeRechargeCard } from './recharge-card-billing';
import { completeCancellation } from './recharge-cancellation';
import { completeRechargeLedgerCallback } from './recharge-ledger-callback';
import { rechargeDocumentDigest, withRechargeReceipt } from './recharge-callback-receipts';

export function assertRetiredRechargeFacts(
  job: IdBusinessV2RechargeJob,
  callback: Record<string, unknown>,
  report: Record<string, unknown>
) {
  const previous = object(job.result);
  const identifier = rechargeOperationIdentifier(previous);
  const evidence = object(report.payment_evidence ?? {});
  const today = object(object(previous.quote ?? {}).today ?? {});
  const period = object(report.subscription_period ?? {});
  if (
    !job.accountKey ||
    typeof identifier !== 'string' ||
    identifier !== rechargeOperationIdentifier(report) ||
    !hasOfficialRechargeQuote(previous) ||
    !previous.quote ||
    !report.quote ||
    rechargeDocumentDigest(safeDocument(previous).quote) !== rechargeDocumentDigest(report.quote) ||
    (callback.accountKey !== undefined && callback.accountKey !== job.accountKey) ||
    (report.account_key !== undefined && report.account_key !== job.accountKey) ||
    (report.account_matched !== undefined && report.account_matched !== true) ||
    [
      'operation',
      'target_plan',
      'current_plan_before',
      'upgrade_invoice_identifier',
      'upgrade_payment_intent_identifier'
    ].some(
      (key) =>
        previous[key] !== undefined && report[key] !== undefined && previous[key] !== report[key]
    ) ||
    (report.subscription_period &&
      (period.account_key !== job.accountKey ||
        period.target_plan !== job.plan ||
        (previous.subscription_period &&
          rechargeDocumentDigest(previous.subscription_period) !==
            rechargeDocumentDigest(report.subscription_period)))) ||
    (report.quote_digest !== undefined &&
      previous.quote_digest !== undefined &&
      report.quote_digest !== previous.quote_digest) ||
    (report.payment_evidence &&
      (evidence.amount_minor !== today.amount_minor ||
        evidence.currency !== today.currency ||
        (evidence.kind === 'checkout_session' && evidence.identifier !== identifier))) ||
    report.payment_attempted !== true ||
    ['confirmation_requests_sent', 'payment_requests_sent'].some(
      (key) => report[key] !== undefined && ![0, 1].includes(report[key] as number)
    ) ||
    (previous.payment_evidence &&
      report.payment_evidence &&
      rechargeDocumentDigest(previous.payment_evidence) !==
        rechargeDocumentDigest(report.payment_evidence))
  )
    throw new ConflictException('迟到付款回执与原账户、原订单或原报价不一致');
  const projected = projectRechargePaymentRecord(job, `payments/${hash(identifier)}.json`, {
    ...report,
    account_key: job.accountKey,
    ...(report.target_plan === undefined ? { target_plan: job.plan } : {}),
    ...(report.confirmation_requests_sent === undefined
      ? { confirmation_requests_sent: previous.confirmation_requests_sent ?? 0 }
      : {}),
    ...(report.payment_status === 'paid' && !report.payment_evidence && previous.payment_evidence
      ? { payment_evidence: previous.payment_evidence }
      : {})
  });
  if (!projected) throw new ConflictException('迟到付款事实尚未通过原单核验');
  return projected;
}

export async function completeRetiredRechargeCallback(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  addressRepository: RechargeAddressRepository;
  audit: V2TransactionalAuditService;
  orders?: BankRechargeOrderService;
  cards?: BankRechargeCardService;
  names?: RechargeNameService;
}) {
  const { tx, job, callback, repository, addressRepository, audit } = input;
  if (callback.type === 'progress') {
    if (job.state === 'finished' && !job.nonceHash)
      throw new ForbiddenException('本机连接凭据无效');
    return { ok: true };
  }
  if (!['finished', 'ledger'].includes(String(callback.type)))
    throw new ConflictException('执行窗口已结束，仅可接收原单付款事实');
  const report = safeDocument(callback.type === 'ledger' ? callback.document : callback.result);
  if (
    callback.type === 'ledger' &&
    callback.accountKey === job.accountKey &&
    job.accountKey &&
    typeof callback.fileKey === 'string' &&
    Number.isSafeInteger(callback.revision)
  ) {
    const record = (await repository.records(tx, job.accountKey)).find(
      (record) =>
        record.ownerId === job.ownerId &&
        record.fileKey === callback.fileKey &&
        record.revision === Number(callback.revision) + 1 &&
        rechargeDocumentDigest(record.document) === rechargeDocumentDigest(report)
    );
    if (record) return { revision: record.revision };
  }
  const previous = object(job.result);
  // A zero-payment cancellation is safe only before any durable payment fact was received.
  const zeroCancellation =
    callback.type === 'finished' &&
    previous.status === 'cancelling' &&
    report.cancellation_confirmed === true &&
    report.payment_attempted === false &&
    report.payment_requests_sent === 0 &&
    Number(report.confirmation_requests_sent ?? 0) === 0;
  if (
    zeroCancellation &&
    (previous.payment_attempted === true ||
      previous.payment_evidence ||
      Number(previous.payment_requests_sent) > 0 ||
      Number(previous.confirmation_requests_sent) > 0)
  )
    return { ok: true };
  const facts = zeroCancellation
    ? mergeRechargePaymentFacts(previous, report)
    : assertRetiredRechargeFacts(job, callback, report);
  if (callback.type === 'ledger') {
    const response = await completeRechargeLedgerCallback({
      tx,
      job,
      callback,
      repository,
      addressRepository,
      audit,
      factsOnly: true
    });
    if (response.replayed) return { revision: response.revision };
    await repository.updateJob(
      tx,
      job.id,
      {
        result: toV2JsonDocument(withRechargeReceipt(job, facts, callback, response, true))
      },
      { factsOnly: true }
    );
    return { revision: response.revision };
  }
  const successful =
    report.status === 'subscription_activated' &&
    report.payment_status === 'paid' &&
    report.payment_outcome === 'subscription_activated' &&
    report.account_matched === true;
  const result = successful
    ? {
        ...facts,
        status: report.status,
        payment_outcome: report.payment_outcome,
        ...Object.fromEntries(
          ['current_plan', 'current_tier', 'subscription_status', 'account_matched']
            .filter((key) => report[key] !== undefined)
            .map((key) => [key, report[key]])
        ),
        ...(report.subscription_period ? { subscription_period: report.subscription_period } : {})
      }
    : facts;
  await consumeRechargeAddress({
    tx,
    rechargeJobId: job.id,
    job,
    report: result,
    addressRepository,
    audit
  });
  if (zeroCancellation) await completeCancellation(tx, job, report, repository, audit);
  const order = await recordVerifiedBankRecharge(tx, job, result, input.orders);
  await finalizeRechargeCard({
    tx,
    job,
    report: result,
    order,
    repository,
    cards: input.cards,
    names: input.names
  });
  const response = { ok: true };
  await repository.updateJob(tx, job.id, {
    state: 'finished',
    nonceHash: null,
    result: toV2JsonDocument(withRechargeReceipt(job, result, callback, response, true))
  });
  return response;
}
