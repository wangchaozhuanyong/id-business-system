import { resolvedDeclinedPayment, resolvedDeclinedCheckout } from './recharge-noncharge-proof';
import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { isClosedCycleDocument } from './recharge-cycle-state';
import { rechargeCheckoutIdentifier, rechargeProfileHasPaymentRisk } from './recharge-job-helpers';
import { object, uuidPattern } from './recharge-validation';

type CheckoutRecord = { ownerId: string; fileKey: string; revision: number; document: unknown };
type CheckoutSource = Pick<
  IdBusinessV2RechargeJob,
  'id' | 'ownerId' | 'accountKey' | 'plan' | 'action' | 'state' | 'result'
>;

const noAcceptedConfirmation = (result: Record<string, unknown>) =>
  (result.manual_confirmation_accepted === undefined ||
    result.manual_confirmation_accepted === false) &&
  result.request_attempt_key === undefined &&
  (result.payment_evidence === undefined || result.payment_evidence === null) &&
  (result.three_ds_status === undefined || result.three_ds_status === 'not_required');

/** 只恢复已保存的安全取消原单；不授予替换、建单或付款能力。 */
export function unpaidCheckoutRecoveryIdentifier(
  job: IdBusinessV2RechargeJob,
  accountKey: string,
  records: CheckoutRecord[]
) {
  const result = object(job.result);
  if (
    job.action !== 'bitbrowser' ||
    job.state !== 'running' ||
    (result.mode !== undefined && result.mode !== 'payment') ||
    result.recheck_only === true ||
    result.resolution_only === true ||
    result.operation === 'subscription_upgrade' ||
    result.payment_requests_sent !== 0 ||
    (result.checkout_requests_sent !== undefined && result.checkout_requests_sent !== 0) ||
    (result.confirmation_requests_sent !== undefined && result.confirmation_requests_sent !== 0) ||
    !noAcceptedConfirmation(result) ||
    rechargeProfileHasPaymentRisk(result)
  )
    return undefined;
  const fileKey = `${accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json`;
  const current = records.filter(
    (record) =>
      !record.fileKey.startsWith('history/') && !isClosedCycleDocument(record.document, accountKey)
  );
  if (
    current.some((record) => {
      if (record.ownerId !== job.ownerId) return true;
      if (!record.fileKey.startsWith('payments/')) return false;
      if (resolvedDeclinedPayment(record.document)) return false;
      if (!record.document || typeof record.document !== 'object' || Array.isArray(record.document))
        return true;
      return ((record.document as Record<string, unknown>).target_plan ?? 'plus') === job.plan;
    })
  )
    return undefined;
  const record = current.find((item) => item.fileKey === fileKey);
  if (
    !record ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !record.document ||
    typeof record.document !== 'object' ||
    Array.isArray(record.document)
  )
    return undefined;
  const document = record.document as Record<string, unknown>;
  if ((document.target_plan ?? 'plus') === job.plan && resolvedDeclinedCheckout(document))
    return rechargeCheckoutIdentifier(document);
  if (
    (document.target_plan ?? 'plus') !== job.plan ||
    document.status !== 'cancelled' ||
    document.checkout_outcome !== 'cancelled' ||
    document.cancelled_before_confirmation !== true ||
    document.payment_attempted !== false ||
    document.payment_requests_sent !== 0 ||
    document.confirmation_requests_sent !== 0 ||
    document.payment_status !== 'not_attempted' ||
    !noAcceptedConfirmation(document) ||
    rechargeProfileHasPaymentRisk(document)
  )
    return undefined;
  return rechargeCheckoutIdentifier(document);
}

/** 旧助手在登录恢复或读报价失败时不报告确认计数；只兼容这两个未进入付款的阶段。 */
function unpaidHistoricalCheckout(result: Record<string, unknown>) {
  const legacyBeforeConfirmation =
    result.confirmation_requests_sent === undefined &&
    result.status === 'blocked' &&
    (result.stage === 'quote_read' ||
      (result.stage === 'session_restore' &&
        result.account_matched === false &&
        result.checkout_requests_sent === 0 &&
        result.quote === undefined));
  return (
    result.payment_attempted === false &&
    result.payment_requests_sent === 0 &&
    result.payment_status === 'not_attempted' &&
    !String(result.stage ?? '').startsWith('payment_') &&
    (result.confirmation_requests_sent === 0 || legacyBeforeConfirmation) &&
    noAcceptedConfirmation(result) &&
    !rechargeProfileHasPaymentRisk(result)
  );
}

export function assertUnpaidCheckoutRecoverySources(
  jobs: CheckoutSource[],
  ownerId: string,
  accountKey: string,
  plan: string
) {
  for (const job of jobs) {
    if (
      job.ownerId !== ownerId ||
      job.accountKey !== accountKey ||
      job.action !== 'bitbrowser' ||
      job.plan !== plan ||
      !uuidPattern.test(job.id) ||
      isClosedCycleDocument(job.result, accountKey)
    )
      continue;
    const result = object(job.result);
    if (resolvedDeclinedPayment(result)) continue;
    if (result.mode === 'open_browser' || result.recheck_only === true) continue;
    const identifier = rechargeCheckoutIdentifier(result);
    if (
      (result.target_plan !== undefined && result.target_plan !== plan) ||
      (result.checkout_requests_sent !== undefined &&
        (!Number.isSafeInteger(result.checkout_requests_sent) ||
          Number(result.checkout_requests_sent) < 0)) ||
      (identifier && (job.state !== 'finished' || !unpaidHistoricalCheckout(result))) ||
      (!identifier && rechargeProfileHasPaymentRisk(result))
    )
      throw new ConflictException('原订单编号不一致，历史付款状态未核实');
  }
}
