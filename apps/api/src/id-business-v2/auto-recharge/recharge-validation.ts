import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  V2_RECHARGE_PLANS,
  type V2RechargeDetailsSubmission,
  type V2RechargeQuote,
  type V2RechargeStart
} from '@apple-business/shared';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { hasOfficialRechargeQuote } from './recharge-upgrade-protocol';

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
    input.action === 'server' &&
    Object.keys(input).some(
      (key) =>
        ![
          'id',
          'action',
          'sessionJson',
          'login',
          'chatgptAccountId',
          'cardId',
          'plan',
          'addressId',
          'manualAddress',
          'details',
          'lockedCurrency',
          'maxAmount',
          'authorizeSinglePayment',
          'proxyId',
          'proxyCountryCode'
        ].includes(key)
    )
  )
    throw new BadRequestException('服务器任务包含不支持的字段');
  if (
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    !V2_RECHARGE_PLANS.includes(input.plan as never) ||
    !['check', 'quote', 'prepare', 'recheck', 'flow', 'server'].includes(String(input.action)) ||
    (input.action !== 'server' &&
      (typeof input.sessionJson !== 'string' ||
        input.sessionJson.length < 2 ||
        Buffer.byteLength(input.sessionJson) > 65000))
  ) {
    throw new BadRequestException('请提供完整授权 JSON、支持的套餐及有效操作');
  }
  if (input.action === 'server') {
    const sourceCount =
      Number(typeof input.sessionJson === 'string') +
      Number(input.login !== undefined) +
      Number(input.chatgptAccountId !== undefined);
    if (sourceCount !== 1) throw new BadRequestException('请选择一种 ChatGPT 登录方式');
    if (
      input.sessionJson !== undefined &&
      (typeof input.sessionJson !== 'string' ||
        input.sessionJson.length < 2 ||
        Buffer.byteLength(input.sessionJson) > 65000)
    )
      throw new BadRequestException('授权 JSON 无效');
    if (
      input.chatgptAccountId !== undefined &&
      (typeof input.chatgptAccountId !== 'string' || !uuidPattern.test(input.chatgptAccountId))
    )
      throw new BadRequestException('ChatGPT 账号编号无效');
    if (
      input.cardId !== undefined &&
      (typeof input.cardId !== 'string' || !uuidPattern.test(input.cardId))
    )
      throw new BadRequestException('银行卡编号无效');
    if (input.login !== undefined) {
      const login = object(input.login);
      if (
        Object.keys(login).some(
          (key) => !['email', 'password', 'totpSecret', 'totpAccountId'].includes(key)
        ) ||
        typeof login.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login.email) ||
        login.email.length > 250 ||
        typeof login.password !== 'string' ||
        login.password.length < 1 ||
        login.password.length > 1024 ||
        (login.totpSecret !== undefined &&
          (typeof login.totpSecret !== 'string' || login.totpSecret.length > 2048)) ||
        (login.totpAccountId !== undefined &&
          (typeof login.totpAccountId !== 'string' || !uuidPattern.test(login.totpAccountId))) ||
        (login.totpSecret !== undefined && login.totpAccountId !== undefined)
      )
        throw new BadRequestException('本次登录资料格式无效');
    }
  } else if (
    input.login !== undefined ||
    input.chatgptAccountId !== undefined ||
    input.cardId !== undefined
  ) {
    throw new BadRequestException('当前步骤无需账号密码或已保存银行卡');
  }
  if (input.action === 'prepare' || input.action === 'server') {
    if (input.action === 'server') {
      if (
        (input.manualAddress !== undefined && input.manualAddress !== true) ||
        Number(input.manualAddress === true) +
          Number(typeof input.addressId === 'string' && uuidPattern.test(input.addressId)) !==
          1
      )
        throw new BadRequestException('请选择地址库资料或手填真实账单地址');
    } else if (
      typeof input.addressId !== 'string' ||
      !uuidPattern.test(input.addressId) ||
      input.manualAddress !== undefined
    ) {
      throw new BadRequestException('请选择未使用的账单地址');
    }
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
    if (
      input.action === 'server' &&
      input.manualAddress === true &&
      (!/^[A-Z]{2}$/.test(String(details.country)) ||
        !String(details.line1).trim() ||
        String(details.line1).length > 180 ||
        String(details.line2).length > 180 ||
        !String(details.city).trim() ||
        String(details.city).length > 120 ||
        String(details.state).length > 120 ||
        !String(details.postal_code).trim() ||
        String(details.postal_code).length > 20)
    )
      throw new BadRequestException('手填账单地址格式无效');
    if (
      input.action === 'server' &&
      (input.authorizeSinglePayment !== true ||
        typeof input.lockedCurrency !== 'string' ||
        !/^[A-Z]{3}$/.test(input.lockedCurrency) ||
        (input.maxAmount !== undefined &&
          (typeof input.maxAmount !== 'string' ||
            !/^[0-9]{1,9}(?:\.[0-9]{1,2})?$/.test(input.maxAmount) ||
            !/[1-9]/.test(input.maxAmount))))
    )
      throw new BadRequestException('请锁定币种并授权本任务一次付款');
    if (
      input.action === 'server' &&
      (typeof input.proxyId !== 'string' ||
        !uuidPattern.test(input.proxyId) ||
        typeof input.proxyCountryCode !== 'string' ||
        !/^[A-Z]{2}$/.test(input.proxyCountryCode))
    ) {
      throw new BadRequestException('请选择有效的代理国家和代理 IP');
    }
    if (
      input.action === 'server' &&
      input.login &&
      String(details.email).toLowerCase() !== String(object(input.login).email).trim().toLowerCase()
    )
      throw new BadRequestException('账单邮箱与登录账号不一致');
    if (
      input.action !== 'server' &&
      (input.proxyId !== undefined || input.proxyCountryCode !== undefined)
    ) {
      throw new BadRequestException('当前步骤无需选择代理 IP');
    }
  } else if (
    input.details !== undefined ||
    input.addressId !== undefined ||
    input.manualAddress !== undefined ||
    input.lockedCurrency !== undefined ||
    input.maxAmount !== undefined ||
    input.authorizeSinglePayment !== undefined ||
    input.proxyId !== undefined ||
    input.proxyCountryCode !== undefined
  ) {
    throw new BadRequestException('当前步骤无需银行卡或账单地址资料');
  }
  return input as unknown as V2RechargeStart;
}

const detailFields = [
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
] as const;

export function validateDetailsSubmission(value: unknown): V2RechargeDetailsSubmission {
  const input = object(value);
  if (typeof input.addressId !== 'string' || !uuidPattern.test(input.addressId)) {
    throw new BadRequestException('请选择未使用的账单地址');
  }
  const details = object(input.details);
  if (
    Object.keys(details).some((key) => !detailFields.includes(key as never)) ||
    detailFields.some(
      (key) => typeof details[key] !== 'string' || String(details[key]).length > 250
    )
  ) {
    throw new BadRequestException('请补齐本次银行卡与真实账单资料');
  }
  return input as unknown as V2RechargeDetailsSubmission;
}

function confirmationMaterial(id: string, quote: V2RechargeQuote) {
  const money = (value: V2RechargeQuote['today']) =>
    value ? `${value.currency}:${value.amount_minor}:${value.amount}` : '-';
  return [
    'auto-recharge-confirm-v1',
    id,
    quote.plan,
    money(quote.today),
    money(quote.tax),
    money(quote.renewal),
    quote.renewal_interval ?? '-'
  ].join('|');
}

export function confirmationNonce(id: string, quote: V2RechargeQuote, secret: string) {
  return createHmac('sha256', secret).update(confirmationMaterial(id, quote)).digest('hex');
}

export function validateWorkerConfirmation(
  id: string,
  job: { action: string; state: string; plan: string },
  report: Record<string, unknown>,
  result: unknown,
  workerToken: string
) {
  const nonce = object(result).nonce;
  const quote = object(report.quote) as unknown as V2RechargeQuote;
  assertFinalQuote(quote, job.plan, report.quote_authority, report);
  const expected = confirmationNonce(id, quote, workerToken);
  if (
    !['prepare', 'flow', 'server'].includes(job.action) ||
    job.state !== 'running' ||
    typeof nonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    nonce.length !== expected.length ||
    !timingSafeEqual(Buffer.from(nonce), Buffer.from(expected))
  )
    throw new ConflictException('不能确认当前报价');
  return hash(nonce);
}

export function resultWithConfirmation(
  job: { id: string; state: string; nonceHash: string | null; result: unknown },
  workerToken: string
) {
  const result = object(job.result);
  if (job.state !== 'awaiting_confirmation' || !job.nonceHash || !result.quote) return result;
  try {
    const nonce = confirmationNonce(job.id, result.quote as V2RechargeQuote, workerToken);
    return hash(nonce) === job.nonceHash ? { ...result, nonce } : result;
  } catch {
    return result;
  }
}

export function assertFinalQuote(
  quote: V2RechargeQuote,
  plan: string,
  authority: unknown,
  binding: Record<string, unknown> = {}
) {
  if (
    quote.plan !== plan ||
    !quote.today ||
    !quote.tax ||
    !quote.renewal ||
    quote.renewal_interval !== 'monthly' ||
    quote.today.currency !== quote.tax.currency ||
    quote.today.currency !== quote.renewal.currency ||
    !hasOfficialRechargeQuote({ ...binding, quote_authority: authority, quote })
  ) {
    throw new BadRequestException('官网最终报价不完整或未绑定当前订单');
  }
}

// 不保存任意服务端正文；只有执行协议中的已脱敏字段能够进入数据库。
const scalarKeys = new Set(
  'status reason stage session_status account_matched current_plan current_tier target_plan recheck_plan checkout_status checkout_identifier subscription_status inspection_only recheck_only payment_status payment_outcome payment_attempted payment_failure_reason confirmation_requests_sent checkout_requests_sent payment_requests_sent payment_requests_blocked repeated_payment http_status browser_error_code card_last4 checkout_outcome payment_record_write_failed last_reason updated_at schema_version run_id created_at plan current_plan_before retry_of transport returned_currency processor_entity credential_refreshed checkout_link_available error_type browser_profile_id locked_currency max_amount user_action_required stale_cleanup_job_id checkout_replacement_performed'.split(
    ' '
  )
);
const paymentFailureReasons = new Set([
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'incorrect_number',
  'invalid_number',
  'insufficient_funds',
  'authentication_required',
  'payment_intent_binding_changed',
  'official_payment_evidence_not_observed',
  'payment_response_not_verified',
  'three_ds_binding_unverified',
  'three_ds_authentication_failed'
]);
for (const key of [
  'cancellation_confirmed',
  'cancelled_before_confirmation',
  'browser_cleanup_status',
  'resolution_only',
  'operator_resolution',
  'resolved_at',
  'resolution_job_id',
  'source_job_id',
  'verification_job_id'
]) {
  scalarKeys.add(key);
}
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
  if (
    result.payment_failure_reason !== undefined &&
    !paymentFailureReasons.has(String(result.payment_failure_reason))
  )
    delete result.payment_failure_reason;
  if (
    result.recheck_plan !== undefined &&
    !V2_RECHARGE_PLANS.includes(result.recheck_plan as never)
  )
    delete result.recheck_plan;
  if (
    [
      'not_required',
      'authenticating',
      'awaiting_user',
      'completed',
      'failed',
      'unsupported'
    ].includes(String(input.three_ds_status))
  )
    result.three_ds_status = input.three_ds_status;
  const period =
    input.subscription_period &&
    typeof input.subscription_period === 'object' &&
    !Array.isArray(input.subscription_period)
      ? object(input.subscription_period)
      : {};
  const canonicalTime = (value: unknown) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  if (
    Object.keys(period).length === 5 &&
    period.source === 'official_subscription_response' &&
    canonicalTime(period.start) &&
    canonicalTime(period.end) &&
    Date.parse(period.start as string) < Date.parse(period.end as string) &&
    Date.parse(period.end as string) - Date.parse(period.start as string) <=
      32 * 24 * 60 * 60 * 1000 &&
    typeof period.account_key === 'string' &&
    /^[a-f0-9]{64}$/.test(period.account_key) &&
    V2_RECHARGE_PLANS.includes(period.target_plan as never)
  )
    result.subscription_period = {
      source: period.source,
      start: period.start,
      end: period.end,
      account_key: period.account_key,
      target_plan: period.target_plan
    };
  const cleanQuote = (value: unknown) => {
    const quote = object(value);
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
        'USD MYR PHP CLP EUR GBP AUD CAD JPY KRW SGD INR IDR THB VND TWD HKD BRL MXN AED SAR ZAR NZD CHF SEK NOK DKK PLN TRY'.split(
          ' '
        );
      const places = ['JPY', 'KRW', 'VND', 'CLP'].includes(item.currency) ? 0 : 2;
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
    return {
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
  };
  for (const [key, min, max] of [
    ['proxy_attempt', 1, 10],
    ['proxy_wait_seconds', 20, 20],
    ['session_attempt', 1, 3],
    ['session_attempt_limit', 1, 3],
    ['session_elapsed_seconds', 0, 600],
    ['session_wait_seconds', 60, 600],
    ['session_refresh_count', 0, 1],
    ['quote_elapsed_seconds', 0, 600],
    ['quote_wait_seconds', 60, 600],
    ['quote_refresh_count', 0, 1],
    ['stale_profiles_cleaned', 0, 30]
  ] as const) {
    if (Number.isSafeInteger(input[key]) && Number(input[key]) >= min && Number(input[key]) <= max)
      result[key] = input[key];
  }
  if (input.proxy_attempt_limit === 1 || input.proxy_attempt_limit === 10)
    result.proxy_attempt_limit = input.proxy_attempt_limit;
  if (
    ['page_load', 'page_refresh', 'session_read', 'account_read'].includes(
      String(input.session_step)
    )
  )
    result.session_step = input.session_step;
  if (
    [
      'blank',
      'loading',
      'checkout',
      'quote_incomplete',
      'official_error',
      'network_error'
    ].includes(String(input.page_state))
  )
    result.page_state = input.page_state;
  if (input.quote !== undefined) result.quote = cleanQuote(input.quote);
  if (input.initial_quote !== undefined) result.initial_quote = cleanQuote(input.initial_quote);
  if (
    ['official_checkout_response', 'official_upgrade_preview'].includes(
      String(input.quote_authority)
    )
  ) {
    result.quote_authority = input.quote_authority;
  }
  if (input.operation === 'subscription_upgrade') result.operation = input.operation;
  for (const [key, pattern] of [
    ['upgrade_identifier', /^upg_[a-f0-9]{32}$/],
    ['upgrade_invoice_identifier', /^in_[A-Za-z0-9]{1,180}$/],
    ['upgrade_payment_intent_identifier', /^pi_[A-Za-z0-9]{1,180}$/]
  ] as const) {
    if (typeof input[key] === 'string' && pattern.test(input[key])) result[key] = input[key];
  }
  if (input.diagnostics !== undefined) {
    const diagnostic = object(input.diagnostics);
    const clean: Record<string, unknown> = {};
    const enums: Record<string, string[]> = {
      step: [
        'open_menu',
        'pricing_page',
        'personal_plans',
        'choose_tier',
        'choose_plan',
        'verify_plan'
      ],
      error_type: [
        'TimeoutError',
        'AssertionError',
        'Error',
        'TargetClosedError',
        'UnexpectedError'
      ],
      role: ['button', 'link', 'radio', 'tab', 'region']
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
      !['checkout_session', 'payment_intent', 'invoice'].includes(String(evidence.kind)) ||
      typeof evidence.identifier !== 'string' ||
      !(
        evidence.kind === 'invoice'
          ? /^in_[A-Za-z0-9]{1,180}$/
          : evidence.kind === 'payment_intent'
            ? /^pi_[A-Za-z0-9]{1,180}$/
            : /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/
      ).test(evidence.identifier) ||
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
