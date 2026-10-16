/** 仅允许在原窗口发现未识别结算，不授予新建单或付款能力。 */
export function isUnidentifiedUnpaidCheckout(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const zero = (n: unknown) => n === undefined || n === null || n === 0;
  return (
    r.status === 'blocked' &&
    r.reason === 'checkout_unknown_write' &&
    r.stage === 'checkout_create' &&
    r.account_matched === true &&
    r.payment_status === 'not_attempted' &&
    r.checkout_requests_sent === 1 &&
    (r.payment_attempted === undefined || r.payment_attempted === false) &&
    [
      'payment_requests_sent',
      'confirmation_requests_sent',
      'card_tokenization_requests_sent'
    ].every((k) => zero(r[k])) &&
    [
      'checkout_identifier',
      'payment_evidence',
      'manual_confirmation_accepted',
      'upgrade_identifier',
      'operation'
    ].every((k) => r[k] === undefined || r[k] === null || r[k] === false)
  );
}

type RecoverySource = {
  id: string;
  ownerId: string;
  accountKey: string | null;
  action: string;
  state: string;
  plan: string;
  result: unknown;
};

/** 登录记录不是建单来源；替换窗口须有完整的归属链和独立的官网身份核实。 */
export function findUnidentifiedCheckoutSource<T extends RecoverySource>(
  jobs: T[],
  ownerId: string,
  accountKey: string,
  plan: string,
  profileId: string
): T | undefined {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const profile = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
  const owned = jobs.filter(
    (job) =>
      job.ownerId === ownerId &&
      job.accountKey === accountKey &&
      job.action === 'bitbrowser' &&
      job.state === 'finished'
  );
  const sources = owned.filter(
    (job) => job.plan === plan && isUnidentifiedUnpaidCheckout(job.result)
  );
  if (sources.length !== 1 || !profile(profileId)) return undefined;
  const source = sources[0]!;
  const originalProfile = object(source.result).browser_profile_id;
  if (!profile(originalProfile)) return undefined;
  const logins = owned.filter((job) => {
    const r = object(job.result);
    return (
      r.mode === 'open_browser' &&
      r.payment_attempted === false &&
      r.payment_requests_sent === 0 &&
      (r.payment_status === undefined || r.payment_status === 'not_attempted') &&
      [
        'checkout_requests_sent',
        'confirmation_requests_sent',
        'card_tokenization_requests_sent'
      ].every((key) => r[key] === undefined || r[key] === 0) &&
      !r.manual_confirmation_accepted &&
      !r.payment_evidence
    );
  });
  const seen = new Set<string>();
  let current = profileId;
  while (current !== originalProfile) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (
      !logins.some((job) => {
        const r = object(job.result);
        return (
          r.browser_profile_id === current &&
          r.status === 'session_ready' &&
          r.account_matched === true
        );
      })
    )
      return undefined;
    const parents = new Set(
      logins
        .map((job) => object(job.result))
        .filter(
          (r) =>
            r.browser_profile_id === current &&
            r.browser_profile_missing_confirmed === true &&
            profile(r.replaced_browser_profile_id)
        )
        .map((r) => r.replaced_browser_profile_id as string)
    );
    if (parents.size !== 1) return undefined;
    current = [...parents][0]!;
  }
  return source;
}
