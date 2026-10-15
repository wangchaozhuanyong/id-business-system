const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function hasDeclineResolution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.operator_resolution === 'confirmed_declined_no_charge' &&
    !v.payment_evidence &&
    typeof v.resolved_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?Z$/.test(v.resolved_at) &&
    ['resolution_job_id', 'source_job_id', 'verification_job_id'].every(
      (key) => typeof v[key] === 'string' && uuid.test(v[key])
    )
  );
}
export function resolvedDeclinedPayment(value: unknown): boolean {
  if (!hasDeclineResolution(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.payment_status === 'declined' &&
    v.payment_attempted === true &&
    v.confirmation_requests_sent === 1
  );
}
export function resolvedDeclinedCheckout(value: unknown): boolean {
  if (!hasDeclineResolution(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.payment_status === 'not_attempted' &&
    v.payment_attempted !== true &&
    (v.confirmation_requests_sent === undefined || v.confirmation_requests_sent === 0) &&
    typeof v.checkout_identifier === 'string' &&
    /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier)
  );
}

export function declinedResolutionEligible(job: {
  action: string;
  state: string;
  accountKey: string | null;
  result: unknown;
}) {
  const v = (job.result ?? {}) as Record<string, unknown>;
  return (
    job.action === 'bitbrowser' &&
    job.state === 'finished' &&
    Boolean(job.accountKey) &&
    v.recheck_only !== true &&
    v.operation !== 'subscription_upgrade' &&
    v.payment_status === 'declined' &&
    v.payment_attempted === true &&
    v.confirmation_requests_sent === 1 &&
    !v.payment_evidence &&
    !v.operator_resolution &&
    typeof v.checkout_identifier === 'string' &&
    /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier)
  );
}
