import { sanitizeV2CheckoutDiagnostic, type V2CheckoutDiagnostic } from '@apple-business/shared';
import { paymentObject } from './bitbrowser-payment-evidence';

export const CHECKOUT_ERROR_BODY_LIMIT = 32_768;

export function checkoutDiagnosticSummary(value: unknown): string {
  const clean = sanitizeV2CheckoutDiagnostic(value);
  if (!Object.keys(clean).length) return '';
  const codes = {
    invalid_request_error: '请求参数被拒绝',
    invalid_request: '请求无效',
    invalid_parameter: '参数无效',
    missing_required_parameter: '缺少必填参数',
    missing: '缺少必填参数',
    literal_error: '参数值不在允许范围',
    invalid_plan: '套餐无效',
    unsupported_country: '不支持该国家或地区',
    unsupported_currency: '不支持该币种',
    already_subscribed: '已有订阅',
    subscription_exists: '订阅已存在',
    checkout_session_exists: '结账单已存在',
    checkout_session_expired: '结账单已过期',
    rate_limit_exceeded: '请求频率受限',
    authentication_error: '身份验证失败',
    permission_denied: '访问被拒绝',
    promotion_not_eligible: '不符合优惠条件'
  };
  const params = {
    plan_name: '套餐',
    checkout_source: '建单来源',
    checkout_ui_mode: '结账界面模式',
    billing_details: '账单资料',
    'billing_details.country': '账单国家',
    'billing_details.currency': '账单币种',
    country: '国家',
    currency: '币种',
    checkout_appearance: '结账外观',
    entry_point: '套餐入口',
    purchase_attempt_id: '建单关联标识',
    supports_saved_payment_link: '已保存支付方式选项',
    cancel_url: '取消返回地址',
    promo_campaign: '优惠活动',
    promotion_code: '优惠代码'
  };
  const categories = {
    authentication: '身份验证',
    rate_limit: '请求频率',
    promotion: '优惠条件',
    existing_subscription: '已有订阅',
    pending_checkout: '待处理结账单',
    plan_validation: '套餐校验',
    currency: '币种',
    region: '地区',
    request_validation: '请求校验',
    checkout_unavailable: '结账不可用'
  };
  const parts: string[] = [];
  if (clean.code) parts.push(`官网拒绝信息：${codes[clean.code]}。`);
  if (clean.param) parts.push(`涉及字段：${params[clean.param]}。`);
  if (!clean.code && clean.categories?.length)
    parts.push(
      `正文线索：${clean.categories.map((key) => categories[key]).join('、')}；尚未证实根因。`
    );
  else if (!clean.code) parts.push('具体拒绝原因仍无法归因。');
  if (clean.body_state && !['parsed_json', 'plain_text'].includes(clean.body_state))
    parts.push('本次未取得可分析的完整拒绝正文。');
  return parts.join('');
}

/** Response text exists only in this call; only closed diagnostic values leave it. */
export function checkoutErrorDiagnostic(body: {
  body?: unknown;
  base64Encoded?: unknown;
}): V2CheckoutDiagnostic {
  if (typeof body.body !== 'string') return { body_state: 'unavailable' };
  if (body.body.length > CHECKOUT_ERROR_BODY_LIMIT) return { body_state: 'oversized' };
  if (body.base64Encoded) return { body_state: 'base64' };
  if (!body.body.trim()) return { body_state: 'empty', attribution: 'unclassified' };
  let raw: Record<string, unknown> = {};
  let state: V2CheckoutDiagnostic['body_state'] = 'plain_text';
  try {
    raw = paymentObject(JSON.parse(body.body));
    state = 'parsed_json';
  } catch {
    // A non-JSON response can still contain a known refusal; its text is never retained.
  }
  const error = paymentObject(raw.error);
  const detail = paymentObject(raw.detail);
  const validation = Array.isArray(raw.detail) ? raw.detail.slice(0, 10).map(paymentObject) : [];
  const codes = [
    raw.code,
    error.code,
    detail.code,
    error.type,
    detail.type,
    ...validation.map((item) => item.type)
  ];
  const params = [
    raw.param,
    error.param,
    detail.param,
    ...validation.map((item) => {
      const loc = item.loc;
      return Array.isArray(loc) &&
        loc.length <= 4 &&
        loc.every((value) => typeof value === 'string')
        ? (loc[0] === 'body' ? loc.slice(1) : loc).join('.')
        : undefined;
    })
  ];
  const safeCode = codes.map((code) => sanitizeV2CheckoutDiagnostic({ code }).code).find(Boolean);
  const safeParam = params
    .map((param) => sanitizeV2CheckoutDiagnostic({ param }).param)
    .find(Boolean);
  const messages = [
    state === 'plain_text' ? body.body : undefined,
    raw.message,
    ...validation.map((item) => item.msg),
    typeof raw.error === 'string' ? raw.error : error.message,
    typeof raw.detail === 'string' ? raw.detail : detail.message
  ]
    .filter((value): value is string => typeof value === 'string' && value.length <= 2000)
    .join(' ')
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const patterns = {
    authentication:
      /(?:unauthenticated|unauthorized|invalid.{0,20}(?:token|session)|session expired)/i,
    rate_limit: /rate.{0,10}limit|too many requests/i,
    promotion: /promot|promo|discount/i,
    existing_subscription: /already.{0,30}subscr|subscr.{0,30}already|active subscription/i,
    pending_checkout: /pending.{0,30}(?:checkout|payment)|existing.{0,30}checkout/i,
    plan_validation:
      /(?:unknown|invalid|unsupported).{0,25}(?:plan|tier)|(?:plan|tier).{0,25}(?:unknown|invalid|unsupported)/i,
    currency: /currency/i,
    region: /country|region/i,
    request_validation: /\b(?:validation|invalid|missing|required)\b/i,
    checkout_unavailable:
      /(?:checkout|payment form).{0,30}(?:unavailable|expired)|(?:unable|failed).{0,25}(?:create|load).{0,25}(?:checkout|payment form)/i
  };
  const categories = Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(messages))
    .map(([key]) => key);
  return sanitizeV2CheckoutDiagnostic({
    body_state: state,
    code: safeCode,
    param: safeParam,
    code_present: codes.some((code) => typeof code === 'string' && code.length > 0),
    param_present: params.some((param) => typeof param === 'string' && param.length > 0),
    categories,
    attribution: safeCode
      ? 'structured_code'
      : categories.length
        ? 'message_pattern'
        : 'unclassified'
  });
}
