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
