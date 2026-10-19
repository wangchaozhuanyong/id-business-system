import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { V2TransactionalAuditService, type V2CommandTransaction } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';
import {
  hasOfficialRechargeQuote,
  isRechargeUpgrade,
  rechargeOperationIdentifier
} from './recharge-upgrade-protocol';

import { hasOfficialTerminalNoncharge, TERMINAL_FAILURE_KEY } from './recharge-noncharge-proof';
export { hasOfficialTerminalNoncharge, TERMINAL_FAILURE_KEY } from './recharge-noncharge-proof';

export async function closeOfficialTerminalFailure(
  tx: V2CommandTransaction,
  repository: RechargeRepository,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>
) {
  const previous = object(job.result),
    confirmation = object(previous._direct_confirmation_v1 ?? {});
  const attempt = object(previous._shared_card_attempt_v1 ?? {});
  const upgrade = previous.operation === 'subscription_upgrade';
  const identifier = rechargeOperationIdentifier(previous);
  const intent = upgrade
    ? previous.upgrade_payment_intent_identifier
    : previous.payment_intent_identifier;
  if (hasOfficialTerminalNoncharge(previous)) return;
  if (
    job.action !== 'bitbrowser' ||
    !job.accountKey ||
    !hasOfficialRechargeQuote(previous) ||
    object(previous.quote ?? {}).plan !== job.plan ||
    (upgrade &&
      (!isRechargeUpgrade(report) ||
        report.current_plan_before !== previous.current_plan_before ||
        report.target_plan !== job.plan)) ||
    previous.recheck_only === true ||
    previous.resolution_only === true ||
    previous._direct_unexpected_payment_v1 ||
    confirmation.consumed !== true ||
    previous.manual_confirmation_accepted !== true ||
    attempt.outcome !== 'declined' ||
    report.status !== 'payment_failed' ||
    report.stage !== 'payment_result' ||
    report.payment_status !== 'declined' ||
    report.payment_attempted !== true ||
    report.confirmation_requests_sent !== 1 ||
    report.payment_requests_sent !== 1 ||
    report.account_matched !== true ||
    previous.payment_evidence ||
    report.payment_evidence ||
    typeof identifier !== 'string' ||
    typeof intent !== 'string' ||
    !/^pi_[A-Za-z0-9]{1,180}$/.test(intent) ||
    (upgrade
      ? report.upgrade_payment_intent_identifier !== intent
      : report.payment_intent_identifier !== intent) ||
    (previous.payment_intent_identifier !== undefined &&
      previous.payment_intent_identifier !== intent) ||
    (report.payment_intent_identifier !== undefined &&
      report.payment_intent_identifier !== intent) ||
    rechargeOperationIdentifier(report) !== identifier ||
    confirmation.checkoutIdentifier !== identifier ||
    confirmation.quoteDigest !== previous.quote_digest
  )
    return;
  const proof = {
    kind: 'bound_payment_intent_declined',
    sourceJobId: job.id,
    accountKey: job.accountKey,
    checkoutIdentifier: identifier,
    paymentIntentIdentifier: intent,
    plan: job.plan,
    confirmedAt: new Date().toISOString()
  };
  await repository.closeOfficialDeclinedRecords(tx, job, proof);
  previous[TERMINAL_FAILURE_KEY] = proof;
  await new V2TransactionalAuditService().append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.official_decline.complete',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      checkoutIdentifier: String(proof.checkoutIdentifier),
      terminalIntentVerified: true,
      paymentFactsPreserved: true
    },
    remark: '原单已绑定付款意图明确拒付，保留原请求事实并结束该次付款防重保护'
  });
}
