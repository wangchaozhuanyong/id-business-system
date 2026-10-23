'use strict';

const { performance } = require('node:perf_hooks');
const LABELS = Object.freeze({
  navigation: '原结账页导航',
  login_gate: '结账页登录提示检查',
  login_chrome: '访客登录控件检查',
  login_button: '登录按钮',
  login_link: '登录链接',
  signup_button: '注册按钮',
  signup_link: '注册链接',
  signup_text: '注册提示',
  tailored_text: '访客欢迎提示',
  login_text: '继续登录提示',
  readiness: '支付控件就绪检查',
  final_page: '结账页最终检查',
  final_auth: '最终登录检查'
});
const STATES = new Set(['pending', 'completed', 'true', 'false', 'read_failed']);
const ERRORS = new Set([
  'timeout',
  'closed',
  'detached',
  'context_destroyed',
  'aborted',
  'read_failed'
]);
const MEDIA_PHASES = new Set([
  'idle',
  'fonts',
  'frames',
  'mask',
  'screenshot',
  'write',
  'cleanup',
  'settled'
]);
const bounded = (value) => Number.isInteger(value) && value >= 0 && value <= 3600000;
function errorClass(error) {
  const value =
    String(error?.code || '') +
    ' ' +
    String(error?.name || '') +
    ' ' +
    String(error?.message || '');
  if (/timeout|timed.out/i.test(value)) return 'timeout';
  if (/closed|TargetClosed/i.test(value)) return 'closed';
  if (/context.*destroy|execution.*context/i.test(value)) return 'context_destroyed';
  if (/detach/i.test(value)) return 'detached';
  if (/abort|cancel|LEASE_LOST/i.test(value)) return 'aborted';
  return 'read_failed';
}
function sanitize(value) {
  if (
    !value ||
    value.version !== 1 ||
    !bounded(value.elapsedMs) ||
    !Array.isArray(value.steps) ||
    value.steps.length > 48
  )
    return undefined;
  const steps = [];
  for (const row of value.steps) {
    if (
      !row ||
      !Object.hasOwn(LABELS, row.step) ||
      !STATES.has(row.state) ||
      !bounded(row.startedMs) ||
      !bounded(row.remainingMs)
    )
      return undefined;
    const clean = {
      step: row.step,
      state: row.state,
      startedMs: row.startedMs,
      remainingMs: row.remainingMs
    };
    for (const key of ['endedMs', 'durationMs', 'remainingAfterMs']) {
      if (row[key] !== undefined) {
        if (!bounded(row[key])) return undefined;
        clean[key] = row[key];
      }
    }
    if (row.errorClass !== undefined) {
      if (!ERRORS.has(row.errorClass)) return undefined;
      clean.errorClass = row.errorClass;
    }
    steps.push(clean);
  }
  const result = { version: 1, elapsedMs: value.elapsedMs, steps };
  if (
    [
      'BUDGET_TIMEOUT',
      'PLAYWRIGHT_TIMEOUT',
      'AUTH_READ_FAILED',
      'LEASE_LOST',
      'VERIFICATION_CANCELLED',
      'OTHER'
    ].includes(value.failureCode)
  )
    result.failureCode = value.failureCode;
  if (
    ['native_checkout', 'hosted_checkout', 'login', 'other', 'closed', 'unknown'].includes(
      value.pageKind
    )
  )
    result.pageKind = value.pageKind;
  const media = value.media;
  if (media && typeof media.available === 'boolean') {
    result.media = { available: media.available };
    for (const key of ['busy', 'chainPending', 'captureTimedOut', 'fontsReady'])
      if (typeof media[key] === 'boolean') result.media[key] = media[key];
    if (MEDIA_PHASES.has(media.phase)) result.media.phase = media.phase;
    if (MEDIA_PHASES.has(media.failurePhase)) result.media.failurePhase = media.failurePhase;
    for (const key of [
      'phaseElapsedMs',
      'lastStartedAgoMs',
      'lastFinishedAgoMs',
      'frameIndex',
      'completedFrames'
    ])
      if (bounded(media[key])) result.media[key] = media[key];
  }
  const cleanup = value.cleanup;
  if (cleanup && bounded(cleanup.frozenAtMs)) {
    result.cleanup = { frozenAtMs: cleanup.frozenAtMs };
    for (const key of ['closeStartedMs', 'closeEndedMs'])
      if (bounded(cleanup[key])) result.cleanup[key] = cleanup[key];
    if (typeof cleanup.closeConfirmed === 'boolean')
      result.cleanup.closeConfirmed = cleanup.closeConfirmed;
  }
  return result;
}
function create(budget) {
  const started = performance.now(),
    steps = [];
  let frozen = false;
  const elapsed = () => Math.min(3600000, Math.max(0, Math.floor(performance.now() - started)));
  const remaining = () => Math.min(3600000, Math.max(0, Math.floor(budget.remaining())));
  return {
    elapsed,
    async run(step, operation) {
      budget.assert();
      const row = { step, state: 'pending', startedMs: elapsed(), remainingMs: remaining() };
      if (!frozen && Object.hasOwn(LABELS, step) && steps.length < 48) steps.push(row);
      try {
        const result = await operation();
        if (!frozen) row.state = typeof result === 'boolean' ? String(result) : 'completed';
        return result;
      } catch (error) {
        if (!frozen) {
          row.state = 'read_failed';
          row.errorClass = errorClass(error);
        }
        throw error;
      } finally {
        if (!frozen) {
          row.endedMs = elapsed();
          row.durationMs = row.endedMs - row.startedMs;
          row.remainingAfterMs = remaining();
        }
      }
    },
    freeze() {
      frozen = true;
      return sanitize({ version: 1, elapsedMs: elapsed(), steps });
    }
  };
}
module.exports = { create, sanitize, errorClass, LABELS };
