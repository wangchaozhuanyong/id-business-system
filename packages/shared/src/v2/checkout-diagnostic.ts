/** Closed vocabulary shared by the passive browser observer and callback sanitizer. */
export const V2_CHECKOUT_ERROR_CODES = [
  'invalid_request_error',
  'invalid_request',
  'invalid_parameter',
  'missing_required_parameter',
  'missing',
  'literal_error',
  'invalid_plan',
  'unsupported_country',
  'unsupported_currency',
  'already_subscribed',
  'subscription_exists',
  'checkout_session_exists',
  'checkout_session_expired',
  'rate_limit_exceeded',
  'authentication_error',
  'permission_denied',
  'promotion_not_eligible'
] as const;
export const V2_CHECKOUT_ERROR_PARAMS = [
  'plan_name',
  'checkout_source',
  'checkout_ui_mode',
  'billing_details',
  'billing_details.country',
  'billing_details.currency',
  'country',
  'currency',
  'checkout_appearance',
  'entry_point',
  'purchase_attempt_id',
  'supports_saved_payment_link',
  'cancel_url',
  'promo_campaign',
  'promotion_code'
] as const;
export const V2_CHECKOUT_ERROR_CATEGORIES = [
  'authentication',
  'rate_limit',
  'promotion',
  'existing_subscription',
  'pending_checkout',
  'plan_validation',
  'currency',
  'region',
  'request_validation',
  'checkout_unavailable'
] as const;
export const V2_CHECKOUT_BODY_STATES = [
  'reading',
  'parsed_json',
  'plain_text',
  'empty',
  'oversized',
  'base64',
  'unavailable',
  'detached'
] as const;
export interface V2CheckoutDiagnostic {
  /** Job id + this local ordinal identifies the request without retaining server headers. */
  request_index?: number;
  body_state?: (typeof V2_CHECKOUT_BODY_STATES)[number];
  code?: (typeof V2_CHECKOUT_ERROR_CODES)[number];
  param?: (typeof V2_CHECKOUT_ERROR_PARAMS)[number];
  code_present?: boolean;
  param_present?: boolean;
  categories?: (typeof V2_CHECKOUT_ERROR_CATEGORIES)[number][];
  attribution?: 'structured_code' | 'message_pattern' | 'unclassified';
}

/** Never accept arbitrary code/parameter strings, messages, URLs, headers or response bodies. */
export function sanitizeV2CheckoutDiagnostic(value: unknown): V2CheckoutDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const clean: V2CheckoutDiagnostic = {};
  if (
    Number.isSafeInteger(input.request_index) &&
    Number(input.request_index) >= 1 &&
    Number(input.request_index) <= 10
  )
    clean.request_index = Number(input.request_index);
  if (V2_CHECKOUT_BODY_STATES.includes(input.body_state as never))
    clean.body_state = input.body_state as V2CheckoutDiagnostic['body_state'];
  if (V2_CHECKOUT_ERROR_CODES.includes(input.code as never))
    clean.code = input.code as V2CheckoutDiagnostic['code'];
  if (V2_CHECKOUT_ERROR_PARAMS.includes(input.param as never))
    clean.param = input.param as V2CheckoutDiagnostic['param'];
  for (const key of ['code_present', 'param_present'] as const)
    if (typeof input[key] === 'boolean') clean[key] = input[key];
  if (Array.isArray(input.categories))
    clean.categories = V2_CHECKOUT_ERROR_CATEGORIES.filter((item) =>
      (input.categories as unknown[]).includes(item)
    );
  if (['structured_code', 'message_pattern', 'unclassified'].includes(String(input.attribution)))
    clean.attribution = input.attribution as V2CheckoutDiagnostic['attribution'];
  return clean;
}
