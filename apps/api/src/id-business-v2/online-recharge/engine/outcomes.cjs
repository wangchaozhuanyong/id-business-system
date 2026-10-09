'use strict';

const SUCCESS = new Set([
  'success',
  'succeeded',
  'completed',
  'paid',
  'active',
  '开通成功',
  '成功'
]);
const FAILED = new Set([
  'failed',
  'declined',
  'canceled',
  'cancelled',
  'error',
  'expired',
  'rejected',
  '失败',
  '取消'
]);
const normalize = (s) =>
  String(s || '')
    .trim()
    .toLowerCase();
const isSuccessGptApiStatus = (s) => SUCCESS.has(normalize(s));
const isTerminalGptApiStatus = (s) => SUCCESS.has(normalize(s)) || FAILED.has(normalize(s));
function isVerifiedPaymentRedirect(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      ['chatgpt.com', 'pay.openai.com', 'checkout.stripe.com'].includes(url.hostname) &&
      !/\/(auth|login|signin)(\/|$)/i.test(url.pathname) &&
      url.searchParams.get('redirect_status') === 'succeeded'
    );
  } catch {
    return false;
  }
}
function analyzeProcessOutput(output, structuredResult = null) {
  if (structuredResult?.success === true) return { status: 'success', shouldRetry: false };
  if (structuredResult?.resultUnknown) return { status: 'result_unknown', shouldRetry: false };
  return { status: 'failed', shouldRetry: false };
}
module.exports = {
  isSuccessGptApiStatus,
  isTerminalGptApiStatus,
  isVerifiedPaymentRedirect,
  analyzeProcessOutput
};
