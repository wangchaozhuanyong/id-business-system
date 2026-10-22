'use strict';

// Only fixed enums and booleans leave this module. Response bodies, header
// values, identities and credentials remain transient inputs to the diagnosis.
const ERROR_CODES = new Set([
  'unsupported_country',
  'unsupported_country_region_territory',
  'region_not_supported',
  'subscription_sharing',
  'invalid_token',
  'token_expired',
  'invalid_session',
  'session_expired',
  'invalid_api_key',
  'access_denied',
  'permission_denied'
]);
const ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error']);
function contentType(value) {
  const type = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return ['application/json', 'text/html', 'text/plain'].includes(type)
    ? type
    : type
      ? 'other'
      : 'unknown';
}
function responseFacts(status, headers = {}, body) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const mitigated = String(normalized['cf-mitigated'] || '')
    .trim()
    .toLowerCase();
  const type = contentType(normalized['content-type']);
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
  }
  const json = Boolean(data && typeof data === 'object' && !Array.isArray(data));
  const html = type === 'text/html' && !json && typeof body === 'string' ? body : '';
  const markers = {
    challengePlatform: /\/cdn-cgi\/challenge-platform\//i.test(html),
    challengeOptions: /\b_cf_chl_opt\b|\b__cf_chl_[a-z_]+\b/i.test(html),
    justAMoment: /just a moment/i.test(html),
    unusualActivity: /unusual activity/i.test(typeof body === 'string' ? body : '')
  };
  const code = json && ERROR_CODES.has(data.error?.code) ? data.error.code : 'UNKNOWN';
  const errorType = json && ERROR_TYPES.has(data.error?.type) ? data.error.type : 'UNKNOWN';
  const classification =
    mitigated === 'challenge' || markers.challengePlatform || markers.challengeOptions
      ? 'CF_CHALLENGE'
      : status === 403 &&
          [
            'unsupported_country',
            'unsupported_country_region_territory',
            'region_not_supported',
            'subscription_sharing'
          ].includes(code)
        ? 'POLICY_OR_REGION_BLOCK'
        : [401, 403].includes(status) &&
            [
              'invalid_token',
              'token_expired',
              'invalid_session',
              'session_expired',
              'invalid_api_key'
            ].includes(code)
          ? 'AUTH_SESSION_REJECTED'
          : status === 403
            ? 'UNKNOWN_403'
            : 'NOT_CLASSIFIED';
  return {
    contentType: type,
    cfMitigated: mitigated === 'challenge' ? 'challenge' : mitigated ? 'unknown' : 'absent',
    cfRayPresent: Boolean(normalized['cf-ray']),
    isJson: json,
    markers,
    errorCode: code,
    errorType,
    classification
  };
}
function logResponseFacts(status, facts) {
  const categories = {
    CF_CHALLENGE: '明确验证挑战',
    POLICY_OR_REGION_BLOCK: '明确地区或策略限制',
    AUTH_SESSION_REJECTED: '明确拒绝登录资料',
    UNKNOWN_403: '拒绝原因未知',
    NOT_CLASSIFIED: '未分类'
  };
  const yn = (value) => (value ? '是' : '否');
  const codes = {
    unsupported_country: '国家或地区不支持',
    unsupported_country_region_territory: '国家或地区不支持',
    region_not_supported: '地区不支持',
    subscription_sharing: '订阅共享限制',
    invalid_token: '令牌无效',
    token_expired: '令牌过期',
    invalid_session: '会话无效',
    session_expired: '会话过期',
    invalid_api_key: '认证凭据被拒绝',
    access_denied: '访问被拒绝',
    permission_denied: '权限被拒绝',
    UNKNOWN: '未知'
  };
  const types = {
    invalid_request_error: '请求错误',
    authentication_error: '认证错误',
    permission_error: '权限错误',
    UNKNOWN: '未知'
  };
  console.log(
    `[订阅分诊] HTTP状态=${status}；内容类型=${facts.contentType}；挑战响应头=${facts.cfMitigated === 'challenge' ? '明确挑战' : facts.cfMitigated === 'absent' ? '未提供' : '未知'}；Ray存在=${yn(facts.cfRayPresent)}；分类=${categories[facts.classification]}；错误码含义=${codes[facts.errorCode]}；错误类型=${types[facts.errorType]}；挑战脚本=${yn(facts.markers.challengePlatform)}；挑战配置=${yn(facts.markers.challengeOptions)}；等待提示=${yn(facts.markers.justAMoment)}；异常活动提示=${yn(facts.markers.unusualActivity)}`
  );
}
function observeAuthResponses(page, sessionRaw) {
  const auth = require('./upstream/session-auth');
  const input = auth.resolveSessionInput(sessionRaw);
  const profile = auth.extractProfileFromToken(input.accessToken);
  const expectedAccount = profile.accountId || input.sessionData?.account?.id;
  const expectedUser = input.sessionData?.user?.id || profile.userId;
  const receipts = { session: { observed: false }, csrf: { observed: false } };
  let active = true;
  const response = async (value) => {
    let kind;
    try {
      const url = new URL(value.url());
      if (url.origin !== 'https://chatgpt.com') return;
      kind =
        url.pathname === '/api/auth/session'
          ? 'session'
          : url.pathname === '/api/auth/csrf'
            ? 'csrf'
            : null;
      if (!kind) return;
      const receipt = {
        observed: true,
        httpStatus: value.status(),
        contentType: contentType(value.headers()['content-type']),
        complete: false
      };
      receipts[kind] = receipt;
      const text = await value.text();
      if (!active || receipts[kind] !== receipt) return;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      const isJson = Boolean(data && typeof data === 'object' && !Array.isArray(data));
      const knownFields = [
        'WARNING_BANNER',
        'accessToken',
        'account',
        'user',
        'authProvider',
        'expires',
        'sessionToken',
        'statsigContext',
        'marketingEligibility',
        'csrfToken'
      ];
      Object.assign(receipt, {
        complete: true,
        isJson,
        fields: isJson ? Object.keys(data).filter((key) => knownFields.includes(key)) : [],
        unknownFieldCount: isJson
          ? Object.keys(data).filter((key) => !knownFields.includes(key)).length
          : 0
      });
      if (kind === 'session') {
        const observed = auth.extractProfileFromToken(data?.accessToken);
        const accounts = [data?.account?.id, observed.accountId].filter(Boolean);
        const hasValidUser =
          receipt.httpStatus === 200 &&
          isJson &&
          !data.error &&
          !data.errors &&
          typeof data.user?.id === 'string' &&
          Boolean(data.user.id.trim());
        Object.assign(receipt, {
          hasValidUser,
          matchesTargetAccount:
            hasValidUser &&
            Boolean(expectedAccount && expectedUser) &&
            accounts.length > 0 &&
            accounts.every((id) => id === expectedAccount) &&
            data.user.id === expectedUser
        });
      } else
        receipt.hasCsrfToken =
          receipt.httpStatus === 200 &&
          typeof data?.csrfToken === 'string' &&
          Boolean(data.csrfToken);
      console.log(
        `[会话分诊] 接口=${kind === 'session' ? 'Session' : 'CSRF'}；HTTP状态=${receipt.httpStatus}；内容类型=${receipt.contentType}；响应完整=${receipt.complete}；JSON=${receipt.isJson}；${kind === 'session' ? `有效用户=${receipt.hasValidUser}；原账号匹配=${receipt.matchesTargetAccount}` : `令牌存在=${receipt.hasCsrfToken}`}`
      );
    } catch {
      // Passive observation cannot reject login or create another request.
    }
  };
  page.on('response', response);
  return {
    snapshot: () => structuredClone(receipts),
    dispose: () => {
      active = false;
      page.off('response', response);
      for (const [kind, receipt] of Object.entries(receipts)) {
        if (!receipt.observed || !receipt.complete)
          console.log(
            `[会话分诊] 接口=${kind === 'session' ? 'Session' : 'CSRF'}；${receipt.observed ? '响应读取不完整' : '未观察到响应'}；仅记录诊断，不新增流程门槛`
          );
      }
    }
  };
}
module.exports = { responseFacts, logResponseFacts, observeAuthResponses };
