import { BadRequestException } from '@nestjs/common';
import { V2_RECHARGE_PLANS, type V2RechargeStart } from '@apple-business/shared';
import { createHash } from 'node:crypto';

export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('输入格式无效');
  }
  return value as Record<string, unknown>;
}
export function validateStart(value: unknown): V2RechargeStart {
  const input = object(value);
  if (
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    !V2_RECHARGE_PLANS.includes(input.plan as never) ||
    !['check', 'quote', 'prepare', 'recheck'].includes(String(input.action)) ||
    typeof input.sessionJson !== 'string' ||
    input.sessionJson.length < 2 ||
    Buffer.byteLength(input.sessionJson) > 65000
  ) {
    throw new BadRequestException('请提供完整授权 JSON、支持的套餐及有效操作');
  }
  if (input.action === 'prepare') {
    const details = object(input.details);
    const fields = [
      'number',
      'expiry',
      'cvc',
      'name',
      'email',
      'country',
      'line1',
      'line2',
      'city',
      'state',
      'postal_code'
    ];
    if (
      Object.keys(details).some((key) => !fields.includes(key)) ||
      fields.some((key) => typeof details[key] !== 'string' || String(details[key]).length > 250)
    ) {
      throw new BadRequestException('请补齐本次银行卡与真实账单资料');
    }
  } else if (input.details !== undefined) {
    throw new BadRequestException('当前步骤无需银行卡资料');
  }
  return input as unknown as V2RechargeStart;
}

// 不保存任意服务端正文；只有执行协议中的已脱敏字段能够进入数据库。
const scalarKeys = new Set(
  'status reason stage session_status account_matched current_plan current_tier target_plan checkout_status checkout_identifier subscription_status inspection_only recheck_only payment_status payment_outcome payment_attempted confirmation_requests_sent checkout_requests_sent payment_requests_sent payment_requests_blocked repeated_payment http_status browser_error_code card_last4 checkout_outcome payment_record_write_failed last_reason updated_at schema_version run_id created_at plan current_plan_before retry_of transport returned_currency processor_entity credential_refreshed checkout_link_available error_type'.split(
    ' '
  )
);
export function safeDocument(value: unknown): Record<string, unknown> {
  const input = object(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      scalarKeys.has(key) &&
      (item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isSafeInteger(item)) ||
        (typeof item === 'string' && /^[A-Za-z0-9_ .:/-]{0,220}$/.test(item)))
    )
      result[key] = item;
  }
  if (input.quote !== undefined) {
    const quote = object(input.quote);
    const money = (value: unknown) => {
      if (value === null || value === undefined) return null;
      const item = object(value);
      if (
        typeof item.amount !== 'string' ||
        !/^\d+(?:\.\d{1,3})?$/.test(item.amount) ||
        item.amount.split('.')[0]!.length > 9 ||
        typeof item.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(item.currency) ||
        !Number.isSafeInteger(item.amount_minor) ||
        Number(item.amount_minor) < 0
      ) {
        throw new BadRequestException('官方报价格式不明确');
      }
      const supported =
        'USD MYR PHP EUR GBP AUD CAD JPY KRW SGD INR IDR THB VND TWD HKD BRL MXN AED SAR ZAR NZD CHF SEK NOK DKK PLN TRY'.split(
          ' '
        );
      const places = ['JPY', 'KRW', 'VND'].includes(item.currency) ? 0 : 2;
      const [whole, fraction = ''] = item.amount.split('.');
      if (
        !supported.includes(item.currency) ||
        fraction.length !== places ||
        BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction || '0') !==
          BigInt(item.amount_minor as number)
      ) {
        throw new BadRequestException('金额与币种精度不一致');
      }
      return { amount: item.amount, currency: item.currency, amount_minor: item.amount_minor };
    };
    result.quote = {
      plan: V2_RECHARGE_PLANS.includes(quote.plan as never) ? quote.plan : null,
      today: money(quote.today),
      tax: money(quote.tax),
      renewal: money(quote.renewal),
      source: quote.source === 'official_checkout_visible_text' ? quote.source : null,
      tax_status: ['estimated', 'displayed', 'unknown'].includes(String(quote.tax_status))
        ? quote.tax_status
        : null,
      renewal_interval: quote.renewal_interval === 'monthly' ? 'monthly' : null
    };
  }
  if (input.diagnostics !== undefined) {
    const diagnostic = object(input.diagnostics);
    const clean: Record<string, unknown> = {};
    const enums: Record<string, string[]> = {
      step: ['open_menu', 'personal_plans', 'choose_tier', 'choose_plan', 'verify_plan'],
      error_type: [
        'TimeoutError',
        'AssertionError',
        'Error',
        'TargetClosedError',
        'UnexpectedError'
      ],
      role: ['button', 'radio', 'tab', 'region']
    };
    for (const [key, values] of Object.entries(enums)) {
      if (typeof diagnostic[key] === 'string' && values.includes(diagnostic[key]))
        clean[key] = diagnostic[key];
    }
    if (
      Number.isSafeInteger(diagnostic.matched_count) &&
      Number(diagnostic.matched_count) >= 0 &&
      Number(diagnostic.matched_count) <= 100
    )
      clean.matched_count = diagnostic.matched_count;
    for (const key of ['enabled', 'selected']) {
      if (typeof diagnostic[key] === 'boolean') clean[key] = diagnostic[key];
    }
    const availablePlans = diagnostic.available_plans;
    if (Array.isArray(availablePlans))
      clean.available_plans = V2_RECHARGE_PLANS.filter((plan) => availablePlans.includes(plan));
    result.diagnostics = clean;
  }
  for (const key of ['account_key', 'quote_digest']) {
    if (typeof input[key] === 'string' && /^[a-f0-9]{64}$/.test(input[key]))
      result[key] = input[key];
  }
  if (input.network) {
    const network = object(input.network);
    result.network = {
      ip:
        typeof network.ip === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(network.ip)
          ? network.ip
          : null,
      country:
        typeof network.country === 'string' && /^[A-Z]{2}$/.test(network.country)
          ? network.country
          : null,
      observedAt: new Date().toISOString()
    };
  }
  if (input.payment_evidence) {
    const evidence = object(input.payment_evidence);
    if (
      !['checkout_session', 'payment_intent'].includes(String(evidence.kind)) ||
      typeof evidence.identifier !== 'string' ||
      !/^(?:cs|oaics|pi)_[A-Za-z0-9_]{1,200}$/.test(evidence.identifier) ||
      !Number.isSafeInteger(evidence.amount_minor) ||
      Number(evidence.amount_minor) < 0 ||
      typeof evidence.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(evidence.currency)
    ) {
      throw new BadRequestException('付款证据格式不明确');
    }
    result.payment_evidence = {
      kind: evidence.kind,
      identifier: evidence.identifier,
      amount_minor: evidence.amount_minor,
      currency: evidence.currency
    };
  }
  return result;
}
