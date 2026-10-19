import type { V2RechargeManualSettlement } from './auto-recharge';
/** Server-owned human reconciliation. It never replaces the observed payment facts. */
const MANUAL_SETTLEMENT_KEY = 'manual_settlement';
export function readV2RechargeManualSettlement(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  const raw = result[MANUAL_SETTLEMENT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const proof = raw as Record<string, unknown>;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    Object.keys(proof).some(
      (key) =>
        ![
          'version',
          'outcome',
          'operationId',
          'sourceJobId',
          'operatorId',
          'accountKey',
          'identifier',
          'plan',
          'resolvedAt',
          'requestDigest',
          'orderId'
        ].includes(key)
    ) ||
    proof.version !== 1 ||
    !['success', 'failure'].includes(String(proof.outcome)) ||
    !['operationId', 'sourceJobId', 'operatorId'].every(
      (key) => typeof proof[key] === 'string' && uuid.test(proof[key])
    ) ||
    typeof proof.accountKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.accountKey) ||
    typeof proof.identifier !== 'string' ||
    !/^(?:(?:cs|oaics)_[A-Za-z0-9_]{1,200}|upg_[a-f0-9]{32})$/.test(proof.identifier) ||
    typeof proof.plan !== 'string' ||
    !['go', 'plus', 'pro-5x', 'pro-20x', 'pro-500'].includes(proof.plan) ||
    proof.identifier !==
      (result.operation === 'subscription_upgrade'
        ? result.upgrade_identifier
        : result.checkout_identifier) ||
    (result.target_plan !== undefined && proof.plan !== result.target_plan) ||
    (result.account_key !== undefined && proof.accountKey !== result.account_key) ||
    typeof proof.resolvedAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.resolvedAt)) ||
    new Date(proof.resolvedAt).toISOString() !== proof.resolvedAt ||
    typeof proof.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.requestDigest) ||
    (proof.outcome === 'success' &&
      (typeof proof.orderId !== 'string' || !uuid.test(proof.orderId))) ||
    (proof.outcome === 'failure' &&
      (proof.orderId !== undefined ||
        result.payment_evidence ||
        result.payment_status === 'paid' ||
        result.status === 'subscription_activated' ||
        result.payment_outcome === 'subscription_activated'))
  )
    return;
  return proof as unknown as V2RechargeManualSettlement;
}
