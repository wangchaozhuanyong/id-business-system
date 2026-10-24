'use strict';

const { performance } = require('node:perf_hooks');
const form = require('./checkout-form.cjs');
const { errorClass } = require('./checkout-await-diagnostics.cjs');
const { createVerificationBudget } = require('./upstream/verification-runtime');
const { prepareCheckoutCardSection } = require('./upstream/stripe-payment');
const { checkoutPageFlags } = require('./checkout-page-state.cjs');

const CODES = new Set([
  'CHECKOUT_FORM_TIMEOUT',
  'CHECKOUT_FORM_ABORTED',
  'CHECKOUT_PAGE_CLOSED',
  'CHECKOUT_CONTROL_READ_FAILED',
  'CHECKOUT_CONTROL_AMBIGUOUS',
  'CHECKOUT_CONTROL_BLOCKED',
  'CHECKOUT_CONTENT_LOAD_FAILED',
  'CHECKOUT_FORM_NOT_READY',
  'PAYMENT_FORM_LOAD_TIMEOUT',
  'CHECKOUT_EXPIRED',
  'HUMAN_VERIFICATION_REQUIRED',
  'LEASE_LOST',
  'VERIFICATION_CANCELLED',
  'VERIFICATION_TIMEOUT'
]);
const failure = (code, inspection) =>
  Object.assign(new Error('Readonly inspection stopped'), {
    code,
    ...(inspection ? { inspection } : {})
  });
const ms = (value) => Math.max(0, Math.min(3600000, Math.floor(value)));
function inspection(value) {
  if (!value || typeof value !== 'object') return undefined;
  const clean = {};
  for (const key of ['complete', 'timedOut', 'aborted', 'pageClosed', 'contentLoadFailed'])
    if (typeof value[key] === 'boolean') clean[key] = value[key];
  for (const key of ['framesChecked', 'framesSkipped', 'framesFailed', 'readAttempts'])
    if (Number.isInteger(value[key]) && value[key] >= 0) clean[key] = ms(value[key]);
  const phases = new Set([
    'frame_scan',
    'frame_owner',
    'load_state',
    'control_snapshot',
    'candidate_handles',
    'candidate_eligibility',
    'control_read',
    'value'
  ]);
  if (phases.has(value.readPhase)) clean.readPhase = value.readPhase;
  clean.readFailures = (Array.isArray(value.readFailures) ? value.readFailures : [])
    .slice(0, 32)
    .filter(
      (row) =>
        phases.has(row.phase) &&
        ['timeout', 'closed', 'aborted', 'detached', 'context_destroyed', 'read_failed'].includes(
          row.reason
        )
    )
    .map((row) => ({ phase: row.phase, reason: row.reason, count: ms(Number(row.count) || 0) }));
  for (const [group, keys] of [
    [
      'frameSkipCounts',
      [
        'hidden',
        'inert',
        'aria_hidden',
        'display_none',
        'visibility_hidden',
        'visibility_collapse',
        'opacity_zero',
        'zero_area',
        'disconnected'
      ]
    ],
    ['controlCounts', ['scanned', 'eligible', 'locatable', 'recognized']]
  ]) {
    clean[group] = {};
    for (const key of keys)
      if (Number.isInteger(value[group]?.[key]) && value[group][key] >= 0)
        clean[group][key] = ms(value[group][key]);
  }
  return clean;
}

// This helper observes an already-open original checkout in an owned diagnostic
// page. It never creates a checkout, chooses a method, fills fields or submits.
// A failed diagnostic closes that page; it must not be used on a shared task page.
async function inspectOriginalCheckout(page, options = {}) {
  const budget = createVerificationBudget({ maxWaitMs: 60000, ...options });
  const started = performance.now(),
    frames = new WeakMap(),
    probes = [],
    reads = [];
  const initialization =
    options.initialization || require('./checkout-initialization.cjs').observe(page);
  const initializationOffsetMs = ms(
    initialization.snapshot().elapsedMs - (performance.now() - started)
  );
  const result = {
    ok: false,
    stopStage: 'payment_form',
    newCheckout: false,
    paymentClicks: 0,
    cardSelected: false,
    cardFilled: false
  };
  let frameSequence = 0,
    probeCount = 0,
    readCount = 0,
    currentProbe,
    frozen = false;
  const elapsed = () => ms(performance.now() - started);
  const retain = (rows, row, cap) => {
    if (rows.length === cap) rows.splice(cap / 2, 1);
    rows.push(row);
  };
  const onRead = (meta, frame) => {
    if (frozen) return;
    if (frame && !frames.has(frame)) frames.set(frame, ++frameSequence);
    const row = {
      id: ++readCount,
      probeId: currentProbe?.id || 0,
      operation: meta.readOperation,
      frameId: frame ? frames.get(frame) : 0,
      frameKind: !frame ? 'unknown' : frame === page.mainFrame() ? 'main' : 'embedded',
      startedMs: elapsed(),
      deadlineMs: elapsed() + ms(meta.remainingMs),
      readBudgetMs: ms(meta.remainingMs),
      attempt: meta.attempt,
      state: 'pending'
    };
    retain(reads, row, 128);
    return (end) => {
      if (frozen) return;
      Object.assign(row, {
        state: end.state,
        durationMs: ms(end.durationMs),
        remainingAfterMs: ms(end.remainingMs),
        endedMs: elapsed()
      });
      if (end.errorClass) row.errorClass = end.errorClass;
      if (typeof end.timedOut === 'boolean') row.timedOut = end.timedOut;
    };
  };
  const run = async (probe, deadline, operation) => {
    budget.assert();
    const row = {
      id: ++probeCount,
      probe,
      state: 'pending',
      startedMs: elapsed(),
      remainingMs: ms(budget.remaining()),
      readBudgetMs: ms(deadline - Date.now())
    };
    retain(probes, row, 48);
    currentProbe = row;
    try {
      const value = await budget.run(operation);
      if (!frozen) row.state = 'completed';
      return value;
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
        row.remainingAfterMs = ms(budget.remaining());
      }
    }
  };
  const freeze = () => {
    if (frozen) return;
    initialization.dispose();
    result.initialization = initialization.snapshot();
    result.trace = {
      probes,
      probeCount,
      probesTruncated: probeCount > probes.length,
      reads,
      readCount,
      readsTruncated: readCount > reads.length,
      frameIdScope: 'diagnostic_only',
      initializationOffsetMs,
      frozenAtMs: elapsed()
    };
    frozen = true;
  };
  let close;
  const closeOwnedPage = () => {
    freeze();
    close ||= page.close({ runBeforeUnload: false }).then(
      () => {
        result.pageCloseConfirmed = page.isClosed();
      },
      () => {
        result.pageCloseConfirmed = page.isClosed();
      }
    );
    return close;
  };
  const abort = () => {
    void closeOwnedPage();
  };
  budget.signal.addEventListener('abort', abort, { once: true });
  try {
    while (budget.remaining() > 0) {
      budget.assert();
      const remainingDeadline = () => Date.now() + budget.remaining();
      const flags = await run('page_flags', remainingDeadline(), () =>
        page.evaluate(checkoutPageFlags)
      );
      result.pageFlags = flags;
      if (flags.formTimeout) throw failure('PAYMENT_FORM_LOAD_TIMEOUT');
      if (flags.expired) throw failure('CHECKOUT_EXPIRED');
      if (flags.challenge) throw failure('HUMAN_VERIFICATION_REQUIRED');
      if (flags.processingError) throw failure('CHECKOUT_CONTENT_LOAD_FAILED');
      // Retain the formal pre-check. Only its owner deadline replaces the
      // temporary fixed two-second full-frame scan. Keep the formal once-only
      // pure-read retry; no checkout recovery/reload is invoked.
      const preDeadline = remainingDeadline();
      if (
        await run('load_precheck', preDeadline, () =>
          form.checkoutPageLoadFailed(page, {
            deadline: preDeadline,
            signal: budget.signal,
            onRead
          })
        )
      )
        throw failure('CHECKOUT_CONTENT_LOAD_FAILED');
      await run('prepare', Math.min(remainingDeadline(), Date.now() + 1000), () =>
        prepareCheckoutCardSection(page, {
          maxWaitMs: Math.min(1000, budget.remaining()),
          deadlineAt: budget.deadlineAt,
          signal: budget.signal,
          onPreparation: (value) => {
            if (!frozen) result.preparation = value;
          }
        })
      );
      if (result.preparation?.complete === false) throw failure('CHECKOUT_CONTROL_READ_FAILED');
      const readDeadline = Math.min(remainingDeadline(), Date.now() + 2000);
      const ready = await run('readiness', readDeadline, () =>
        form.inspectCardReadiness(page, {
          deadline: readDeadline,
          signal: budget.signal,
          onRead
        })
      );
      result.cardReadiness = {
        ready: ready.ready === true,
        code:
          CODES.has(ready.code) ||
          ['CHECKOUT_CARD_READY', 'CHECKOUT_CARD_NOT_READY'].includes(ready.code)
            ? ready.code
            : 'CHECKOUT_CONTROL_READ_FAILED',
        inspection: inspection(ready.inspection)
      };
      if (
        ready.inspection?.complete !== true ||
        (!ready.ready && ready.code !== 'CHECKOUT_CARD_NOT_READY')
      )
        throw failure(result.cardReadiness.code, ready.inspection);
      if (ready.ready) {
        const finalDeadline = remainingDeadline();
        if (
          await run('load_final', finalDeadline, () =>
            form.checkoutPageLoadFailed(page, {
              deadline: finalDeadline,
              signal: budget.signal,
              onRead
            })
          )
        )
          throw failure('CHECKOUT_CONTENT_LOAD_FAILED');
        budget.assert();
        result.ok = true;
        result.stopStage = 'before_payment';
        break;
      }
      await run('wait', remainingDeadline(), () => budget.wait(500));
    }
    if (!result.ok) throw failure('CHECKOUT_FORM_NOT_READY');
  } catch (error) {
    result.errorCode = CODES.has(error.code) ? error.code : 'CHECKOUT_CONTROL_READ_FAILED';
    result.errorClass = errorClass(error);
    result.failedProbe = currentProbe?.probe || 'not_started';
    result.failureInspection = inspection(error.inspection);
    result.failedRead = [...reads].reverse().find((row) => row.state !== 'completed');
    // The detailed operation/frame remains in the bounded read timeline even if
    // the compatible public readPhase is the coarse frame_scan category.
  } finally {
    freeze();
    if (!result.ok) await closeOwnedPage();
    budget.signal.removeEventListener('abort', abort);
    budget.dispose();
    result.elapsedMs = elapsed();
  }
  return result;
}

module.exports = { inspectOriginalCheckout };
