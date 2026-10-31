'use strict';

// Only controlled metadata leaves this module. Raw response
// bodies, header values, identities and credentials remain transient inputs.
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
function responseReadMetadata(headers = {}) {
  const values = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value || '')])
  );
  const mitigated = values['cf-mitigated']?.trim().toLowerCase();
  const encoding = values['transfer-encoding']?.trim().toLowerCase();
  const length = values['content-length'];
  return {
    contentType: contentType(values['content-type']),
    cfMitigated: mitigated === 'challenge' ? 'challenge' : mitigated ? 'unknown' : 'absent',
    cfRayPresent: Boolean(values['cf-ray']),
    transferEncoding: ['chunked', 'identity'].includes(encoding)
      ? encoding
      : encoding
        ? 'other'
        : 'absent',
    server:
      values.server?.trim().toLowerCase() === 'cloudflare'
        ? 'cloudflare'
        : values.server
          ? 'other'
          : 'absent',
    ...(/^\d{1,10}$/.test(length || '') && Number(length) <= 1073741824
      ? { contentLength: Number(length) }
      : {})
  };
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
function sessionProbeFacts(status, headers, text, expected = {}) {
  const facts = responseFacts(status, headers, text);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const object = data && typeof data === 'object' && !Array.isArray(data);
  const hasIdentity =
    object &&
    !data.error &&
    !data.errors &&
    [data.accessToken, data.user?.id, data.user?.email].some(
      (v) => typeof v === 'string' && v.trim()
    );
  let observed = {};
  try {
    observed =
      JSON.parse(Buffer.from(data.accessToken.split('.')[1], 'base64url'))[
        'https://api.openai.com/auth'
      ] || {};
  } catch {
    /* No token identity. */
  }
  const accounts = [data?.account?.id, observed.chatgpt_account_id].filter(Boolean);
  const users = [data?.user?.id, observed.chatgpt_user_id].filter(Boolean);
  const hasValidUser = Boolean(
    status === 200 && hasIdentity && typeof data.user?.id === 'string' && data.user.id.trim()
  );
  const identityMismatch =
    hasIdentity &&
    ((expected.accountId && accounts.some((id) => id !== expected.accountId)) ||
      (expected.userId && users.some((id) => id !== expected.userId)));
  const matchesTargetAccount = Boolean(
    hasValidUser &&
    expected.accountId &&
    expected.userId &&
    accounts.length &&
    accounts.every((id) => id === expected.accountId) &&
    users.every((id) => id === expected.userId)
  );
  const state =
    facts.classification === 'CF_CHALLENGE'
      ? 'challenge'
      : identityMismatch
        ? 'mismatch'
        : status === 401 ||
            (status === 200 && object && Object.keys(data).length === 0) ||
            facts.classification === 'AUTH_SESSION_REJECTED'
          ? 'invalid'
          : status === 200 && hasIdentity
            ? 'verified'
            : status === 403
              ? 'blocked'
              : 'unconfirmed';
  return { state, httpStatus: status, ...facts, hasValidUser, matchesTargetAccount };
}
function safeSessionProbe(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  if (
    [
      'verified',
      'invalid',
      'mismatch',
      'challenge',
      'blocked',
      'timeout',
      'network_error',
      'unconfirmed'
    ].includes(value.state)
  )
    out.state = value.state;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    out.httpStatus = value.httpStatus;
  if (
    ['application/json', 'text/html', 'text/plain', 'other', 'unknown'].includes(value.contentType)
  )
    out.contentType = value.contentType;
  if (['challenge', 'absent', 'unknown'].includes(value.cfMitigated))
    out.cfMitigated = value.cfMitigated;
  for (const key of [
    'cfRayPresent',
    'hasValidUser',
    'matchesTargetAccount',
    'manualActionable',
    'manualCompleted',
    'automaticActionable',
    'automaticAttempted',
    'automaticCompleted',
    'complete'
  ])
    if (typeof value[key] === 'boolean') out[key] = value[key];
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 86400000)
    out.elapsedMs = Math.round(value.elapsedMs);
  if (
    [
      'cleared',
      'solver_disabled',
      'not_actionable',
      'failed',
      'timeout',
      'session_invalid'
    ].includes(value.automaticResult)
  )
    out.automaticResult = value.automaticResult;
  if (
    [
      'CF_CHALLENGE',
      'POLICY_OR_REGION_BLOCK',
      'AUTH_SESSION_REJECTED',
      'UNKNOWN_403',
      'NOT_CLASSIFIED'
    ].includes(value.classification)
  )
    out.classification = value.classification;
  if (ERROR_CODES.has(value.errorCode) || value.errorCode === 'UNKNOWN')
    out.errorCode = value.errorCode;
  if (ERROR_TYPES.has(value.errorType) || value.errorType === 'UNKNOWN')
    out.errorType = value.errorType;
  if (value.markers) {
    out.markers = {};
    for (const key of ['challengePlatform', 'challengeOptions', 'justAMoment', 'unusualActivity'])
      if (typeof value.markers[key] === 'boolean') out.markers[key] = value.markers[key];
  }
  return Object.keys(out).length ? out : undefined;
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
// Passive task-owned context events are installed before the caller starts its
// first Session probe. Request objects distinguish redirect hops without CDP
// port discovery or requestId reuse. No response body or credential is retained.
function observeSessionRequests(
  context,
  log = (value) => console.log('[Session] 请求对照', JSON.stringify(value))
) {
  if (typeof context?.on !== 'function' || typeof context?.off !== 'function')
    return { dispose() {} };
  const records = new WeakMap();
  const started = performance.now();
  let active = true,
    count = 0;
  let connections;
  const isSession = (request) => {
    try {
      const url = new URL(request.url());
      return url.origin === 'https://chatgpt.com' && url.pathname === '/api/auth/session';
    } catch {
      return false;
    }
  };
  const emit = (event, row, detail = {}) => {
    if (!active) return;
    try {
      log({ event, ...row, elapsedMs: Math.round(performance.now() - started), ...detail });
    } catch {
      /* Diagnostic delivery never changes the real request outcome. */
    }
  };
  const request = (value) => {
    try {
      if (!active || count >= 30 || !isSession(value)) return;
      const type = value.resourceType();
      const previous = value.redirectedFrom?.();
      const from = previous && records.get(previous);
      const row = {
        sequence: ++count,
        resourceType: ['document', 'fetch', 'xhr'].includes(type) ? type : 'other',
        redirected: Boolean(previous),
        ...(from ? { redirectedFromSequence: from.sequence } : {}),
        method: value.method() === 'GET' ? 'GET' : 'other'
      };
      records.set(value, row);
      emit('request', row);
      Promise.resolve()
        .then(() => (active ? value.allHeaders() : null))
        .then((raw) => {
          if (!raw || !active) return;
          const headers = Object.fromEntries(
            Object.entries(raw).map(([key, value]) => [key.toLowerCase(), String(value)])
          );
          // Keep only Cookie names and fixed header categories; values stay local.
          const names = String(headers.cookie || '')
            .split(';')
            .map((part) => part.trim().split('=', 1)[0]);
          emit('request_headers', row, {
            complete: true,
            sessionCookieSent: names.some((name) =>
              /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(name)
            ),
            clearanceCookieSent: names.includes('cf_clearance'),
            fetchMode: ['navigate', 'cors', 'same-origin', 'no-cors'].includes(
              headers['sec-fetch-mode']
            )
              ? headers['sec-fetch-mode']
              : 'unknown',
            fetchDestination: ['document', 'empty', 'iframe'].includes(headers['sec-fetch-dest'])
              ? headers['sec-fetch-dest']
              : 'unknown'
          });
        })
        .catch(() => emit('request_headers', row, { complete: false, readFailed: true }));
    } catch {
      /* Browser teardown may race an observation; never replace its outcome. */
    }
  };
  const response = (value) => {
    let row;
    try {
      row = records.get(value.request());
      if (!row) return;
      const status = value.status();
      const metadata = responseReadMetadata(value.headers());
      emit('response', row, {
        complete: true,
        httpStatus: status >= 100 && status <= 599 ? status : 0,
        contentType: metadata.contentType,
        cfMitigated: metadata.cfMitigated,
        cfRayPresent: metadata.cfRayPresent
      });
    } catch {
      if (row) emit('response', row, { complete: false, readFailed: true });
    }
  };
  const failed = (value) => {
    const row = records.get(value);
    if (!row) return;
    try {
      const error = String(value.failure()?.errorText || '');
      emit('request_failed', row, {
        networkClass: /TIMED_OUT/.test(error)
          ? 'timeout'
          : /ABORTED/.test(error)
            ? 'aborted'
            : 'network_error'
      });
    } catch {
      emit('request_failed', row, { networkClass: 'unknown' });
    }
  };
  const dispose = () => {
    active = false;
    try {
      connections?.dispose();
    } catch {
      /* Diagnostic disposal never blocks business cleanup. */
    }
    for (const [event, listener] of [
      ['request', request],
      ['response', response],
      ['requestfailed', failed],
      ['close', dispose]
    ]) {
      try {
        context.off(event, listener);
      } catch {
        /* Never block task teardown. */
      }
    }
  };
  context.on('request', request);
  context.on('response', response);
  context.on('requestfailed', failed);
  context.on('close', dispose);
  try {
    connections = require('./session-connection-diagnostics.cjs').observeSessionConnections(
      context,
      log,
      responseReadMetadata
    );
  } catch {
    emit('connection_observer', {}, { complete: false, reason: 'setup_incomplete' });
  }
  return { dispose };
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
module.exports = {
  observeSessionRequests,
  responseReadMetadata,
  responseFacts,
  sessionProbeFacts,
  safeSessionProbe,
  logResponseFacts,
  observeAuthResponses
};
