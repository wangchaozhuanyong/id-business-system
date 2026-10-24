'use strict';
const codes = new Set([
  'not_eligible',
  'already_subscribed',
  'unsupported_country',
  'unsupported_country_region_territory',
  'region_not_supported',
  'subscription_sharing',
  'invalid_token',
  'invalid_session',
  'token_expired',
  'session_expired',
  'permission_denied',
  'rate_limit_exceeded',
  'invalid_request_error',
  'authentication_error',
  'rate_limit_error'
]);
function create(httpStatus, headers, body, bodyReadComplete = true) {
  const facts = require('./subscription-diagnostics.cjs').responseFacts(httpStatus, headers, body);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = {};
  }
  const error = data?.error || data?.detail || {};
  const errorCode = codes.has(error.code) ? error.code : 'UNKNOWN';
  const errorType = codes.has(error.type) ? error.type : 'UNKNOWN';
  const classification =
    facts.classification === 'CF_CHALLENGE'
      ? 'CF_CHALLENGE'
      : [
            'unsupported_country',
            'unsupported_country_region_territory',
            'region_not_supported',
            'subscription_sharing'
          ].includes(errorCode)
        ? 'POLICY_OR_REGION_BLOCK'
        : errorCode === 'not_eligible'
          ? 'NOT_ELIGIBLE'
          : errorCode === 'already_subscribed'
            ? 'ALREADY_SUBSCRIBED'
            : facts.classification === 'AUTH_SESSION_REJECTED'
              ? 'AUTH_SESSION_REJECTED'
              : httpStatus === 429 || errorType === 'rate_limit_error'
                ? 'RATE_LIMITED'
                : 'UNKNOWN';
  return { httpStatus, bodyReadComplete, errorCode, errorType, classification };
}
function safe(value) {
  if (
    !value ||
    !Number.isInteger(value.httpStatus) ||
    value.httpStatus < 100 ||
    value.httpStatus > 599
  )
    return undefined;
  return {
    httpStatus: value.httpStatus,
    bodyReadComplete: value.bodyReadComplete === true,
    errorCode: codes.has(value.errorCode) ? value.errorCode : 'UNKNOWN',
    errorType: codes.has(value.errorType) ? value.errorType : 'UNKNOWN',
    classification: [
      'CF_CHALLENGE',
      'POLICY_OR_REGION_BLOCK',
      'NOT_ELIGIBLE',
      'ALREADY_SUBSCRIBED',
      'AUTH_SESSION_REJECTED',
      'RATE_LIMITED'
    ].includes(value.classification)
      ? value.classification
      : 'UNKNOWN'
  };
}
function message(value) {
  const facts = safe(value);
  if (!facts) return '官网拒绝创建本次结账单，未提交付款';
  const labels = {
    CF_CHALLENGE: '官网验证阻断',
    POLICY_OR_REGION_BLOCK: '政策或地区限制',
    NOT_ELIGIBLE: '账号不符合套餐条件',
    ALREADY_SUBSCRIBED: '账号已订阅',
    AUTH_SESSION_REJECTED: '会话被拒绝',
    RATE_LIMITED: '请求频率受限',
    UNKNOWN: '原因未确认'
  };
  return `官网拒绝创建本次结账单（HTTP ${facts.httpStatus}，${labels[facts.classification]}），未提交付款`;
}
module.exports = { create, safe, message };
