import type { V2RechargeDetails, V2RechargeStart } from '@apple-business/shared';

const browserProfilePattern = /^[a-f0-9]{32}$/i;

type FinishedRechargeJob = {
  id: string;
  result: unknown;
};

type RechargeAddress = {
  country: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
};

export function isBrowserProfileId(value: unknown): value is string {
  return typeof value === 'string' && browserProfilePattern.test(value);
}

export function staleProfile(job: FinishedRechargeJob, includeCompleted = false) {
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return null;
  const result = job.result as Record<string, unknown>;
  const profileId = result.browser_profile_id;
  const zero = (value: unknown) => value === undefined || value === null || value === 0;
  if (
    !isBrowserProfileId(profileId) ||
    typeof result.reason !== 'string' ||
    result.payment_attempted === true ||
    !zero(result.payment_requests_sent) ||
    !zero(result.confirmation_requests_sent) ||
    (result.payment_status !== undefined &&
      result.payment_status !== null &&
      result.payment_status !== 'not_attempted') ||
    result.payment_outcome === 'succeeded' ||
    result.subscription_status === 'active' ||
    result.user_action_required === true ||
    (!includeCompleted && result.browser_cleanup_status === 'completed')
  )
    return null;
  return { sourceJobId: job.id, profileId };
}

export function rechargeDetailsWithAddress(
  details: V2RechargeDetails,
  address: RechargeAddress
): V2RechargeDetails {
  return {
    ...details,
    country: address.country,
    line1: address.line1,
    line2: '',
    city: address.city,
    state: address.state,
    postal_code: address.postalCode
  };
}

export function clearRechargeDetails(details?: V2RechargeDetails) {
  if (!details) return;
  Object.keys(details).forEach((key) => {
    details[key as keyof V2RechargeDetails] = '';
  });
}

export function clearRechargeStartSecrets(input: V2RechargeStart) {
  input.sessionJson = '';
  clearRechargeDetails(input.details);
}
