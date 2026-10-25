'use strict';

// The same semantic locator is used to write and verify each field. Never infer
// card/billing identity from iframe order or from a previous successful fill.
const rules = {
  number: [/\bcc-number\b/, /card.?number|numberinput/],
  expiry: [/\bcc-exp\b(?!-)/, /expir(?:y|ation|ationdate)|exp-date|expdate/],
  month: [/\bcc-exp-month\b/, /exp.*month/],
  year: [/\bcc-exp-year\b/, /exp.*year/],
  cvc: [/\bcc-csc\b/, /\bcvc\b|\bcvv\b|cardcvc|security.?code|securitycode/],
  name: [
    /\bbilling name\b|^name$|\bcc-name\b/,
    /billing.?name|fullname|full name|nameinput|cardholder.?name|\bname on card\b|\byour name\b|姓名|全名/
  ],
  country: [/\bcountry(?:-name)?\b/, /countryinput|country or region|国家/],
  line1: [
    /\baddress-line1\b/,
    /address.?line.?1|addressline1input|\bstreet\b|^(?:enter(?: your)? )?address$|街道|地址行.?1/
  ],
  city: [/\baddress-level2\b/, /\blocality\b|\bcity\b|localityinput|cityinput|城市/],
  postal: [
    /\bpostal-code\b/,
    /postal.?code|zip.?code|^postal$|\bzip\b|postalcodeinput|邮编|邮政编码/
  ],
  state: [
    /\baddress-level1\b/,
    /administrative.?area|\bstate\b|\bprovince\b|stateinput|provinceinput|省|州/
  ]
};
const labels = {
  number: '卡号',
  expiry: '有效期',
  month: '有效月份',
  year: '有效年份',
  cvc: '安全码',
  name: '账单姓名',
  country: '国家',
  line1: '街道',
  city: '城市',
  postal: '邮编',
  state: '州/省'
};
const billingIds = {
  name: ['billingAddress-nameInput', 'billingName'],
  country: ['billingAddress-countryInput', 'billingCountry'],
  line1: ['billingAddress-addressLine1Input', 'billingAddressLine1'],
  city: ['billingAddress-localityInput', 'billingLocality'],
  postal: ['billingAddress-postalCodeInput', 'billingPostalCode'],
  state: ['billingAddress-administrativeAreaInput', 'billingAdministrativeArea']
};
const billingNames = {
  name: ['name', 'billingName'],
  country: ['country', 'billingCountry', 'billingAddressCountry'],
  line1: ['line1', 'addressLine1', 'billingAddressLine1'],
  city: ['city', 'locality', 'billingLocality', 'billingAddressCity'],
  postal: ['zip', 'postal_code', 'postalCode', 'billingPostalCode', 'billingAddressZip'],
  state: ['state', 'administrativeArea', 'billingAdministrativeArea', 'billingAddressState']
};
const billingTestFields = {
  billingName: 'name',
  billingCountry: 'country',
  billingAddressLine1: 'line1',
  billingLocality: 'city',
  billingPostalCode: 'postal',
  billingAdministrativeArea: 'state'
};
const stableCardFields = { cardNumber: 'number', cardExpiry: 'expiry', cardCvc: 'cvc' };
const normalize = (v) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const countryCode = (v) =>
  ({
    'united states': 'us',
    'united states of america': 'us',
    美国: 'us',
    philippines: 'ph',
    菲律宾: 'ph',
    chile: 'cl',
    智利: 'cl'
  })[normalize(v)] || normalize(v);
const stateName = (v) =>
  ({ or: 'oregon', de: 'delaware', mt: 'montana', nh: 'new hampshire', ak: 'alaska' })[
    normalize(v)
  ] || normalize(v);
const FRAME_READ_MS = 300;
const RETRY_READ_MS = 1200;
function failure(code, message, fields) {
  return Object.assign(new Error(message), { code, errorCode: code, failedFields: fields });
}
function timeout(deadline, signal) {
  if (signal?.aborted) throw failure('CHECKOUT_FORM_ABORTED', '本次填表已停止');
  const left = deadline - Date.now();
  if (left <= 0) throw failure('CHECKOUT_FORM_TIMEOUT', '填表超过本次总时限');
  return Math.min(left, 1200);
}
async function within(operation, deadline, signal) {
  timeout(deadline, signal);
  let timer, onAbort;
  try {
    return await Promise.race([
      typeof operation === 'function' ? operation() : operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(failure('CHECKOUT_FORM_TIMEOUT', '填表超过本次总时限')),
          Math.max(1, deadline - Date.now())
        );
        if (signal) {
          onAbort = () => reject(failure('CHECKOUT_FORM_ABORTED', '本次填表已停止'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
// Opt-in, value-free tracing for an owned readonly diagnostic page. Ordinary
// payment callers retain their existing deadlines and pure-read retry policy.
async function observedRead(operation, deadline, signal, state, readOperation, frame) {
  if (typeof state?.onRead !== 'function' && state?.stopOnReadFailure !== true)
    return within(operation, deadline, signal);
  const startedAt = Date.now();
  let finish;
  try {
    finish = state.onRead(
      {
        readOperation,
        startedAt,
        deadlineAt: deadline,
        remainingMs: Math.max(0, deadline - startedAt),
        attempt: state.readAttempt || 1
      },
      frame
    );
  } catch {
    // An observer cannot change candidate eligibility or the payment flow.
  }
  const end = (row) => {
    try {
      if (typeof finish === 'function')
        finish({
          ...row,
          durationMs: Date.now() - startedAt,
          remainingMs: Math.max(0, deadline - Date.now())
        });
    } catch {
      // Keep observation separate from the operation's outcome.
    }
  };
  try {
    const result = await within(operation, deadline, signal);
    end({ state: 'completed' });
    return result;
  } catch (error) {
    error.readOperation = readOperation;
    const timedOut = error.code === 'CHECKOUT_FORM_TIMEOUT' || error.name === 'TimeoutError';
    if (state.stopOnReadFailure === true) state.readStopped = true;
    end({
      state: 'read_failed',
      timedOut,
      errorClass: require('./checkout-await-diagnostics.cjs').errorClass(error)
    });
    throw error;
  }
}
// Passive field-level observations; no extra page reads or altered read deadlines.
async function fieldStep(state, field, phase, operation) {
  const step = { field, phase, state: 'pending' };
  const candidate = state.formSteps?.at(-1);
  if (phase === 'input' && candidate?.field === field && candidate.state === 'completed')
    for (const key of [
      'frameId',
      'frameKind',
      'tag',
      'role',
      'inShadowRoot',
      'readOnly',
      'locatorKind',
      'candidateCount',
      'eligibleCount',
      'visible'
    ])
      if (candidate[key] !== undefined) step[key] = candidate[key];
  const started = Date.now();
  state.formSteps ||= [];
  state.formSteps.push(step);
  if (state.formSteps.length > 32) state.formSteps.shift();
  const previous = state.formStep;
  state.formStep = step;
  try {
    const result = await operation();
    step.state = 'completed';
    return result;
  } catch (error) {
    step.state = 'failed';
    step.errorClass = require('./checkout-await-diagnostics.cjs').errorClass(error);
    if (
      [
        'frame_scan',
        'candidate_handles',
        'candidate_eligibility',
        'value',
        'control_read'
      ].includes(error.readPhase)
    )
      step.readPhase = error.readPhase;
    throw error;
  } finally {
    step.durationMs = Math.min(600000, Math.max(0, Date.now() - started));
    state.formStep = previous;
  }
}
function score(meta, key) {
  const ac = normalize(meta.ac),
    identity = normalize(`${meta.id} ${meta.name}`),
    description = normalize(`${meta.label} ${meta.placeholder}`);
  const hay = `${ac} ${identity} ${description}`;
  if (billingIds[key]) {
    if (
      /linklegalname|payment-link|\bshipping\b/.test(hay) ||
      ['contact', 'shipping'].includes(meta.scope)
    )
      return 0;
    if (billingIds[key].includes(meta.id) || billingTestFields[meta.testId] === key) return 400;
  }
  if (/email|phone|password|address-line2|addressline2|optional.*address/.test(hay)) return 0;
  if (key === 'expiry' && /exp-month|exp-year|month|year/.test(ac || identity)) return 0;
  if (
    ['name', 'country', 'line1', 'city', 'postal', 'state'].includes(key) &&
    /cc-number|cc-exp|cc-csc|cardnumber|securitycode/.test(hay)
  )
    return 0;
  if (stableCardFields[meta.stableField])
    return stableCardFields[meta.stableField] === key ? 110 : 0;
  const patterns = rules[key];
  let semantic = patterns.some((p) => p.test(ac))
    ? 100
    : patterns.some((p) => p.test(identity))
      ? 80
      : patterns.some((p) => p.test(description))
        ? 60
        : 0;
  if (billingNames[key]?.includes(meta.name)) semantic = Math.max(80, semantic);
  if (!semantic && ['number', 'expiry'].includes(key)) {
    // Keep the upstream number/1234/MM aliases inside the payment locator. Weak
    // aliases must not turn an explicitly named order, quantity or address field
    // into a card field; strong cc-* and stable-field identities are unchanged.
    const descriptionWords = normalize(
      `${meta.id} ${meta.name} ${meta.ac} ${meta.label} ${meta.placeholder}`
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
    );
    const weakInput = meta.tag === 'input' && ['text', 'tel'].includes(meta.type);
    const otherCardField = ['number', 'expiry', 'month', 'year', 'cvc'].some(
      (other) => other !== key && rules[other].some((pattern) => pattern.test(hay))
    );
    const nonCard =
      /\b(?:order|invoice|receipt|quantity|qty|amount|customer|account|postal|zip|phone|email|password|address)\b/.test(
        descriptionWords
      );
    if (weakInput && !nonCard && !otherCardField) {
      if (key === 'number' && normalize(meta.name) === 'number') semantic = 80;
      else if (key === 'number' && /1234/.test(meta.placeholder)) semantic = 60;
      else if (key === 'expiry' && /\bmm\b/i.test(meta.placeholder)) semantic = 60;
    }
  }
  if (!semantic) return 0;
  return (
    semantic +
    (billingIds[key] && meta.scope === 'billing' ? 200 : 0) +
    (['country', 'state'].includes(key) && (meta.tag === 'select' || meta.role === 'combobox')
      ? 10
      : 0)
  );
}
function closed(page) {
  return page.isClosed?.() === true;
}
function inspectionState(page, deadline, signal) {
  return {
    complete: false,
    framesChecked: 0,
    framesSkipped: 0,
    framesFailed: 0,
    readAttempts: 1,
    readFailures: [],
    frameSkipCounts: {},
    controlCounts: { scanned: 0, eligible: 0, locatable: 0, recognized: 0 },
    controlRejectCounts: {},
    contentLoadFailed: false,
    timedOut: Date.now() >= deadline,
    pageClosed: closed(page),
    aborted: signal?.aborted === true
  };
}
function frameReadFailure(inspection, phase, error, page, signal) {
  const reason = signal?.aborted
    ? 'aborted'
    : closed(page)
      ? 'closed'
      : error?.code === 'CHECKOUT_FORM_TIMEOUT' || error?.name === 'TimeoutError'
        ? 'timeout'
        : /execution context was destroyed/i.test(String(error?.message || ''))
          ? 'context_destroyed'
          : /detached/i.test(String(error?.message || ''))
            ? 'detached'
            : 'read_failed';
  const prior = inspection.readFailures.find((row) => row.phase === phase && row.reason === reason);
  if (prior) prior.count = Math.min(10000, prior.count + 1);
  else inspection.readFailures.push({ phase, reason, count: 1 });
}
function inspectionCode(inspection) {
  return inspection.pageClosed
    ? 'CHECKOUT_PAGE_CLOSED'
    : inspection.aborted
      ? 'CHECKOUT_FORM_ABORTED'
      : inspection.contentLoadFailed
        ? 'CHECKOUT_CONTENT_LOAD_FAILED'
        : inspection.timedOut
          ? 'CHECKOUT_FORM_TIMEOUT'
          : inspection.framesFailed
            ? 'CHECKOUT_CONTROL_READ_FAILED'
            : null;
}
function safeControls(items) {
  return items.map(({ meta }) => ({
    tag: ['input', 'select', 'textarea'].includes(meta.tag) ? meta.tag : 'other',
    role: meta.role === 'combobox' ? 'combobox' : null,
    scope: meta.scope,
    required: Boolean(meta.required),
    readOnly: Boolean(meta.readOnly),
    fields: Object.keys(rules).filter((key) => score(meta, key) > 0)
  }));
}
function elementRendered(
  element,
  {
    control = false,
    interaction = false,
    reason = false,
    snapshot = false,
    includeRejected = false,
    describe = false
  } = {}
) {
  // Computed visibility on the target already includes inheritance. A visible
  // child may legally override ancestor visibility. CSS can also override the
  // default display:none of [hidden]; interactive fields/frames must follow the
  // rendered result and subsequent hit tests, not the attribute alone. Text
  // probes retain their semantic hidden exclusion. Other exclusions still apply
  // to the whole composed ancestor chain, including shadow hosts.
  let visibleModals;
  function containsComposed(parent, child) {
    for (let node = child; node; node = node.parentElement || node.getRootNode()?.host)
      if (node === parent) return true;
    return false;
  }
  function paintStack(doc, x, y) {
    const visited = new Set(),
      stack = [];
    function collect(root) {
      if (visited.has(root)) return;
      visited.add(root);
      for (const node of root.elementsFromPoint(x, y)) {
        if (node.shadowRoot) collect(node.shadowRoot);
        if (!stack.includes(node)) stack.push(node);
      }
    }
    collect(doc);
    return stack;
  }
  function rejection(target, isControl, interactive = isControl || interaction, checkModal = true) {
    if (isControl) {
      if (target.matches(':disabled')) return 'disabled';
      if (target.readOnly && target.getAttribute('role') !== 'combobox') return 'readonly';
      if (
        (target.type === 'button' &&
          !(target.tagName === 'BUTTON' && target.getAttribute('role') === 'combobox')) ||
        [
          'hidden',
          'checkbox',
          'color',
          'file',
          'image',
          'radio',
          'range',
          'reset',
          'submit'
        ].includes(target.type)
      )
        return 'excluded_type';
    }
    for (let node = target; node; node = node.parentElement || node.getRootNode()?.host) {
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (node.hidden && (!interactive || style.display === 'none')) return 'hidden';
      if (node.inert) return 'inert';
      // ARIA controls the accessibility tree, not rendering or interactivity.
      // Keep it for text probes; actual fields/frames use physical eligibility
      // plus the same modal and hit-test checks before writing and readback.
      if (!interactive && node.getAttribute('aria-hidden') === 'true') return 'aria_hidden';
      if (isControl && node.getAttribute('aria-disabled') === 'true') return 'aria_disabled';
      if (style.display === 'none') return 'display_none';
      if (Number(style.opacity) === 0) return 'opacity_zero';
      if (style.contentVisibility === 'hidden') return 'content_visibility_hidden';
    }
    const style = target.ownerDocument.defaultView.getComputedStyle(target);
    if (['hidden', 'collapse'].includes(style.visibility)) return 'visibility_hidden';
    const box = target.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return 'zero_geometry';
    if (interactive && checkModal) {
      if (!visibleModals) {
        visibleModals = [];
        const roots = [target.ownerDocument];
        for (const root of roots) {
          for (const node of root.querySelectorAll('*'))
            if (node.shadowRoot) roots.push(node.shadowRoot);
          for (const modal of root.querySelectorAll('dialog[open],[aria-modal="true"]'))
            if (
              (modal.matches(':modal') || modal.getAttribute('aria-modal') === 'true') &&
              !rejection(modal, false, true, false)
            )
              visibleModals.push(modal);
        }
      }
      const owners = visibleModals.filter((modal) => containsComposed(modal, target));
      for (const modal of visibleModals) {
        if (containsComposed(modal, target)) continue;
        const behindOwner = owners.some((owner) => {
          const doc = target.ownerDocument,
            view = doc.defaultView,
            rect = owner.getBoundingClientRect();
          const x = (Math.max(0, rect.left) + Math.min(view.innerWidth, rect.right)) / 2,
            y = (Math.max(0, rect.top) + Math.min(view.innerHeight, rect.bottom)) / 2;
          const stack = paintStack(doc, x, y),
            ownerIndex = stack.findIndex((node) => containsComposed(owner, node)),
            modalIndex = stack.findIndex((node) => containsComposed(modal, node));
          if (ownerIndex >= 0 && modalIndex > ownerIndex) return true;
          // The top native dialog's backdrop intercepts the whole viewport,
          // including a previous dialog that is still :modal beneath it.
          if (owner.matches(':modal') && modal.matches(':modal')) {
            const other = modal.getBoundingClientRect();
            const hit = paintStack(
              doc,
              Math.max(0, Math.min(view.innerWidth - 1, other.left + other.width / 2)),
              Math.max(0, Math.min(view.innerHeight - 1, other.top + other.height / 2))
            )[0];
            return hit && containsComposed(owner, hit);
          }
          return false;
        });
        if (!behindOwner) return 'modal_background';
      }
    }
    return null;
  }
  function boxVisible(target) {
    const box = target.getBoundingClientRect(),
      style = target.ownerDocument.defaultView.getComputedStyle(target);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.display !== 'none' &&
      !['hidden', 'collapse'].includes(style.visibility)
    );
  }
  function rejectedAt(target, rejected) {
    if (!rejected) return 'none';
    for (let node = target; node; node = node.parentElement || node.getRootNode()?.host) {
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (
        (rejected === 'hidden' && node.hidden) ||
        (rejected === 'inert' && node.inert) ||
        (rejected === 'opacity_zero' && Number(style.opacity) === 0) ||
        (rejected === 'display_none' && style.display === 'none') ||
        (rejected === 'content_visibility_hidden' && style.contentVisibility === 'hidden') ||
        (rejected === 'aria_disabled' && node.getAttribute('aria-disabled') === 'true')
      )
        return node === target ? 'self' : 'ancestor';
    }
    return ['visibility_hidden', 'zero_geometry', 'modal_background'].includes(rejected)
      ? 'computed'
      : 'self';
  }
  if (!snapshot) {
    const rejected = rejection(element, control);
    if (describe)
      return {
        reason: rejected,
        at: rejectedAt(element, rejected),
        boxVisible: boxVisible(element)
      };
    return reason ? rejected : !rejected;
  }
  const rejectCounts = {},
    metas = [],
    rejectedMetas = [];
  for (const [index, n] of element.entries()) {
    const rejected = rejection(n, true);
    if (rejected) {
      rejectCounts[rejected] = (rejectCounts[rejected] || 0) + 1;
      if (!includeRejected) continue;
    }
    const meta = (() => {
      let scope = '',
        owner = '';
      for (
        let parent = n.parentElement;
        parent && parent !== n.ownerDocument.body;
        parent = parent.parentElement
      ) {
        const heading = parent.querySelector(
          ':scope > legend,:scope > h2,:scope > h3,:scope > [role="heading"]'
        );
        const label = parent.getAttribute('aria-label') || heading?.textContent || '';
        const identity = `${parent.id} ${parent.getAttribute('data-testid') || ''} ${label}`;
        const kind = /billing.?address/i.test(identity)
          ? 'billing'
          : /shipping|delivery.?address/i.test(identity)
            ? 'shipping'
            : /(?:^|[\s_-])contact(?:$|[\s_-])|payment-link/i.test(identity)
              ? 'contact'
              : '';
        if (!kind) continue;
        scope = kind;
        owner = parent.id
          ? `[id=${JSON.stringify(parent.id)}]`
          : parent.getAttribute('aria-label')
            ? `[aria-label=${JSON.stringify(label)}]`
            : heading
              ? `${parent.tagName.toLowerCase()}:has(> ${heading.tagName.toLowerCase()}:text-is(${JSON.stringify(label)}))`
              : '';
        break;
      }
      return {
        index,
        id: n.id || '',
        name: n.getAttribute('name') || '',
        ac: n.getAttribute('autocomplete') || '',
        stableField: ['cardNumber', 'cardExpiry', 'cardCvc'].includes(
          n.getAttribute('data-elements-stable-field-name')
        )
          ? n.getAttribute('data-elements-stable-field-name')
          : '',
        type: n.type || '',
        testId: [
          'billingName',
          'billingCountry',
          'billingAddressLine1',
          'billingLocality',
          'billingPostalCode',
          'billingAdministrativeArea'
        ].includes(n.getAttribute('data-testid'))
          ? n.getAttribute('data-testid')
          : '',
        placeholder: n.getAttribute('placeholder') || '',
        label: (
          n.getAttribute('aria-label') ||
          (n.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .map((id) => n.getRootNode().getElementById?.(id)?.textContent || '')
            .join(' ')
            .trim() ||
          Array.from(n.labels || [])
            .map((l) => l.textContent)
            .join(' ') ||
          ''
        ).slice(0, 160),
        tag: n.tagName.toLowerCase(),
        role: n.getAttribute('role'),
        inShadowRoot: Boolean(n.getRootNode()?.host),
        scope,
        owner,
        readOnly: Boolean(n.readOnly),
        required: n.required || n.getAttribute('aria-required') === 'true',
        ...(includeRejected
          ? {
              comparison: {
                boxVisible: boxVisible(n),
                editable:
                  !n.matches(':disabled') &&
                  !n.readOnly &&
                  n.getAttribute('aria-disabled') !== 'true' &&
                  n.getAttribute('aria-readonly') !== 'true' &&
                  ![
                    'hidden',
                    'checkbox',
                    'radio',
                    'button',
                    'submit',
                    'reset',
                    'file',
                    'image',
                    'range',
                    'color'
                  ].includes(n.type)
              }
            }
          : {})
      };
    })();
    if (rejected) rejectedMetas.push({ meta, reason: rejected, at: rejectedAt(n, rejected) });
    else metas.push(meta);
  }
  return {
    metas,
    scanned: element.length,
    rejectCounts,
    ...(includeRejected ? { rejectedMetas } : {})
  };
}
async function frameVisible(frame, deadline, signal, inspection, state) {
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    const owner = await observedRead(
      () => current.frameElement(),
      deadline,
      signal,
      state,
      'frame_element',
      current
    );
    try {
      const reason = await observedRead(
        () => owner.evaluate(elementRendered, { reason: true, interaction: true }),
        deadline,
        signal,
        state,
        'owner_visibility',
        current
      );
      if (reason) {
        if (inspection)
          inspection.frameSkipCounts[reason] = (inspection.frameSkipCounts[reason] || 0) + 1;
        return false;
      }
    } finally {
      // Releasing a handle must not extend a failed frame's read budget.
      owner.dispose().catch(() => {});
    }
  }
  return true;
}
async function frameLoadFailed(frame, deadline, signal, state) {
  const matches = frame.getByText('Content failed to load', { exact: true });
  const count = await observedRead(
    () => matches.count(),
    deadline,
    signal,
    state,
    'load_error_count',
    frame
  );
  for (let index = 0; index < count; index++)
    if (
      await observedRead(
        () => matches.nth(index).evaluate(elementRendered),
        deadline,
        signal,
        state,
        'load_error_visibility',
        frame
      )
    )
      return true;
  return false;
}
async function readControlsOnce(page, deadline, state) {
  const inspection = inspectionState(page, deadline, state.signal);
  if (state.interactionChecks?.length) inspection.interactionChecks = state.interactionChecks;
  if (state.interactionRejectCounts)
    inspection.interactionRejectCounts = state.interactionRejectCounts;
  const result = [];
  let frames = [];
  if (!inspectionCode(inspection)) {
    try {
      frames = page.frames();
    } catch {
      inspection.framesFailed++;
      inspection.readPhase = 'frame_scan';
      inspection.readFailures.push({ phase: 'frame_scan', reason: 'read_failed', count: 1 });
    }
  }
  for (const frame of frames) {
    inspection.timedOut ||= Date.now() >= deadline;
    inspection.pageClosed = closed(page);
    inspection.aborted = state.signal?.aborted === true;
    if (inspection.timedOut || inspection.pageClosed || inspection.aborted) break;
    const frameDeadline = Math.min(deadline, Date.now() + (state.readBudgetMs || FRAME_READ_MS));
    let phase = 'frame_owner';
    try {
      if (!(await frameVisible(frame, frameDeadline, state.signal, inspection, state))) {
        inspection.framesSkipped++;
        continue;
      }
      phase = 'load_state';
      if (await frameLoadFailed(frame, frameDeadline, state.signal, state)) {
        inspection.contentLoadFailed = true;
        break;
      }
      const all = frame.locator('input,select,textarea,[role="combobox"]');
      phase = 'control_snapshot';
      const snapshot = await observedRead(
        () => all.evaluateAll(elementRendered, { snapshot: true }),
        frameDeadline,
        state.signal,
        state,
        'control_snapshot',
        frame
      );
      const { metas, scanned, rejectCounts } = snapshot;
      inspection.controlCounts.scanned += scanned;
      inspection.controlCounts.eligible += metas.length;
      for (const [reason, count] of Object.entries(rejectCounts))
        inspection.controlRejectCounts[reason] =
          (inspection.controlRejectCounts[reason] || 0) + count;
      inspection.framesChecked++;
      for (const meta of metas) {
        const root = meta.owner ? frame.locator(meta.owner) : frame;
        // Shared on/off hints do not identify a field. Prefer the upstream stable
        // field identity, and use autocomplete only when it names a known field.
        const semanticAutocomplete = Object.values(rules).some((patterns) =>
          patterns.some((pattern) => pattern.test(normalize(meta.ac)))
        );
        const attribute = meta.id
          ? ['id', meta.id]
          : meta.stableField
            ? ['data-elements-stable-field-name', meta.stableField]
            : meta.testId
              ? ['data-testid', meta.testId]
              : semanticAutocomplete
                ? ['autocomplete', meta.ac]
                : meta.name
                  ? ['name', meta.name]
                  : null;
        const el = attribute
          ? root.locator(
              `${meta.tag}[${attribute[0]}=${JSON.stringify(attribute[1])}]:visible:not(:disabled,[inert],[inert] *,[readonly]:not([role="combobox"]))`
            )
          : meta.label
            ? root.getByLabel(meta.label, { exact: true })
            : meta.placeholder
              ? root.getByPlaceholder(meta.placeholder, { exact: true })
              : null;
        if (el) {
          inspection.controlCounts.locatable++;
          if (Object.keys(rules).some((key) => score(meta, key) > 0))
            inspection.controlCounts.recognized++;
          result.push({
            frame,
            el,
            meta,
            locatorKind: attribute?.[0] || (meta.label ? 'label' : 'placeholder')
          });
        } else
          inspection.controlRejectCounts.no_locator =
            (inspection.controlRejectCounts.no_locator || 0) + 1;
      }
    } catch (error) {
      inspection.framesFailed++;
      inspection.readPhase = 'frame_scan';
      frameReadFailure(inspection, phase, error, page, state.signal);
      // Preserve the total-budget timer even if Date observes the preceding tick.
      // A shorter frame read budget remains an incomplete read, not a global timeout.
      inspection.timedOut ||= error?.code === 'CHECKOUT_FORM_TIMEOUT' && frameDeadline === deadline;
      if (inspection.timedOut || state.readStopped) break;
    }
  }
  inspection.timedOut ||= Date.now() >= deadline;
  inspection.pageClosed = closed(page);
  inspection.aborted = state.signal?.aborted === true;
  inspection.complete = !inspectionCode(inspection);
  state.inspection = inspection;
  state.controls = safeControls(result);
  return { items: result, inspection };
}
async function freshRead(page, deadline, state, read) {
  // Retry only a pure read, once, from a new frame/candidate snapshot. Never
  // retry a retained ElementHandle or any fill/select/click operation here.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const previousHandles = new Set(state.handles || []);
    const previousBudget = state.readBudgetMs;
    try {
      timeout(deadline, state.signal);
      state.readAttempt = attempt;
      state.readBudgetMs = attempt === 1 ? FRAME_READ_MS : RETRY_READ_MS;
      const result = await read();
      if (state.inspection) state.inspection.readAttempts = attempt;
      return result;
    } catch (error) {
      if (state.inspection) state.inspection.readAttempts = attempt;
      for (const handle of state.handles || [])
        if (!previousHandles.has(handle)) {
          state.handles.delete(handle);
          handle.dispose().catch(() => {});
        }
      if (
        attempt === 1 &&
        !state.readStopped &&
        error.interactionRecovery !== true &&
        error.code === 'CHECKOUT_CONTROL_READ_FAILED' &&
        !closed(page) &&
        !state.signal?.aborted &&
        deadline - Date.now() > FRAME_READ_MS
      )
        continue;
      throw error;
    } finally {
      if (previousBudget === undefined) delete state.readBudgetMs;
      else state.readBudgetMs = previousBudget;
    }
  }
}
function candidatesFor(items, key) {
  const candidates = items
    .map((item) => ({ ...item, score: score(item.meta, key) }))
    .filter((item) => item.score > 0);
  const highest = Math.max(0, ...candidates.map((item) => item.score));
  // Two interactive card-number fields are ambiguous even with different
  // autocomplete/label priorities; inspection, writing and readback agree.
  if (key === 'number' && candidates.length > 1) return candidates;
  return candidates.filter((item) => item.score === highest);
}
async function readWithin(
  operation,
  deadline,
  signal,
  readPhase = 'control_read',
  readBudgetMs = FRAME_READ_MS,
  state,
  frame,
  readOperation = readPhase
) {
  try {
    return await observedRead(
      operation,
      Math.min(deadline, Date.now() + readBudgetMs),
      signal,
      state,
      readOperation,
      frame
    );
  } catch (error) {
    if (error.code === 'CHECKOUT_FORM_TIMEOUT' && Date.now() < deadline)
      throw Object.assign(failure('CHECKOUT_CONTROL_READ_FAILED', '结账控件读取未完成'), {
        readPhase,
        ...(error.readOperation ? { readOperation: error.readOperation } : {})
      });
    error.readPhase = readPhase;
    throw error;
  }
}
function interactionPoint(element, child) {
  // Pure DOM observation: never click (including Playwright trial clicks), focus,
  // dispatch an event, or change an upstream attribute to prove eligibility.
  const doc = element.ownerDocument,
    win = doc.defaultView,
    box = element.getBoundingClientRect();
  const width = win.innerWidth,
    height = win.innerHeight;
  let x, y;
  const observed = (result) => ({
    ...result,
    geometry: Object.fromEntries(
      Object.entries({
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        viewportWidth: width,
        viewportHeight: height,
        ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {})
      })
        .filter(([, value]) => Number.isFinite(value) && Math.abs(value) <= 1000000)
        .map(([key, value]) => [key, Math.round(value)])
    )
  });
  if (child) {
    // Axis-aligned scale/translation has a deterministic content-box mapping.
    // Perspective/rotation/skew/zoom cannot be proved by a bounding rectangle.
    for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) {
      const style = win.getComputedStyle(node);
      if (
        (style.perspective && style.perspective !== 'none') ||
        (style.rotate && !['none', '0deg'].includes(style.rotate)) ||
        (style.zoom && !['normal', '1'].includes(style.zoom))
      )
        return observed({ reason: 'unsupported_transform' });
      if (style.scale && style.scale !== 'none')
        if (
          style.scale
            .split(/\s+/)
            .some((part) => !Number.isFinite(Number(part)) || Number(part) <= 0)
        )
          return observed({ reason: 'unsupported_transform' });
      if (style.transform && style.transform !== 'none') {
        const matrix = new win.DOMMatrixReadOnly(style.transform);
        if (
          !matrix.is2D ||
          matrix.a <= 0 ||
          matrix.d <= 0 ||
          Math.abs(matrix.b) > 1e-8 ||
          Math.abs(matrix.c) > 1e-8
        )
          return observed({ reason: 'unsupported_transform' });
      }
    }
    const style = win.getComputedStyle(element);
    if (
      !element.offsetWidth ||
      !element.offsetHeight ||
      !child.width ||
      !child.height ||
      ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].some(
        (key) => parseFloat(style[key]) !== 0
      )
    )
      return observed({ reason: 'unsupported_geometry' });
    x =
      box.left +
      ((element.clientLeft + (child.x * element.clientWidth) / child.width) * box.width) /
        element.offsetWidth;
    y =
      box.top +
      ((element.clientTop + (child.y * element.clientHeight) / child.height) * box.height) /
        element.offsetHeight;
  } else {
    const left = Math.max(0, box.left),
      right = Math.min(width, box.right),
      top = Math.max(0, box.top),
      bottom = Math.min(height, box.bottom);
    if (right <= left || bottom <= top) return observed({ reason: 'outside_viewport' });
    x = (left + right) / 2;
    y = (top + bottom) / 2;
  }
  if (x < 0 || y < 0 || x >= width || y >= height) return observed({ reason: 'outside_viewport' });
  let hit = doc.elementFromPoint(x, y);
  while (hit?.shadowRoot?.elementFromPoint) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  for (let node = hit; node; node = node.parentElement || node.getRootNode()?.host)
    if (node === element) return observed({ x, y, width, height });
  return observed({
    reason: 'occluded',
    blocker: {
      tag: ['DIV', 'SPAN', 'INPUT', 'SELECT', 'BUTTON', 'IFRAME', 'DIALOG'].includes(hit?.tagName)
        ? hit.tagName.toLowerCase()
        : 'other',
      role: ['dialog', 'combobox', 'listbox', 'option'].includes(hit?.getAttribute('role'))
        ? hit.getAttribute('role')
        : 'other',
      containsTarget: Boolean(hit?.contains(element))
    }
  });
}
function scrollErrorClass(error) {
  const message = String(error?.message || '');
  if (/frame.*(?:detached|navigat)/i.test(message)) return 'frame_changed';
  if (/execution context.*destroyed/i.test(message)) return 'context_destroyed';
  if (/detached|not attached/i.test(message)) return 'node_detached';
  return error?.name === 'TimeoutError' ? 'scroll_timeout' : 'other';
}
async function candidateInteraction(item, handle, key, deadline, state, allowScroll = true) {
  const pointChecks = [];
  const rememberPoint = (point, scope, depth) => {
    if (pointChecks.length < 16)
      pointChecks.push({
        scope,
        depth,
        reason: point.reason || 'none',
        ...(point.geometry ? { geometry: point.geometry } : {})
      });
    return point;
  };
  const blocked = (reason) => {
    state.interactionRejectCounts ||= {};
    state.interactionRejectCounts[reason] = (state.interactionRejectCounts[reason] || 0) + 1;
    if (state.inspection) state.inspection.interactionRejectCounts = state.interactionRejectCounts;
    return failure(
      'CHECKOUT_CONTROL_BLOCKED',
      `${labels[key]}当前被遮挡或无法核实交互，未继续填写`,
      [key]
    );
  };
  const readPoint = async () => {
    if (
      !(await readWithin(
        () => handle.evaluate(elementRendered, { control: true }),
        deadline,
        state.signal,
        'control_read',
        FRAME_READ_MS,
        state,
        item.frame,
        'candidate_eligibility'
      ))
    )
      return { reason: 'control_ineligible' };
    let point = await readWithin(
      () => handle.evaluate(interactionPoint),
      deadline,
      state.signal,
      'control_read',
      FRAME_READ_MS,
      state,
      item.frame,
      'interaction_point'
    );
    rememberPoint(point, 'control', 0);
    let depth = 0;
    for (
      let frame = item.frame;
      !point.reason && frame.parentFrame();
      frame = frame.parentFrame()
    ) {
      depth++;
      const owner = await observedRead(
        () => frame.frameElement(),
        deadline,
        state.signal,
        state,
        'frame_element',
        frame
      );
      try {
        if (
          !(await readWithin(
            () => owner.evaluate(elementRendered, { interaction: true }),
            deadline,
            state.signal,
            'control_read',
            FRAME_READ_MS,
            state,
            frame,
            'owner_visibility'
          ))
        )
          return rememberPoint({ reason: 'frame_ineligible' }, 'frame_owner', depth);
        point = await readWithin(
          () => owner.evaluate(interactionPoint, point),
          deadline,
          state.signal,
          'control_read',
          FRAME_READ_MS,
          state,
          frame,
          'owner_interaction_point'
        );
        rememberPoint(point, 'frame_owner', depth);
      } finally {
        owner.dispose().catch(() => {});
      }
    }
    return point;
  };
  let point = await readPoint();
  if (!point.reason) return;
  state.interactionFrames ||= new Map();
  if (!state.interactionFrames.has(item.frame))
    state.interactionFrames.set(item.frame, state.interactionFrames.size + 1);
  const trace = {
    field: key,
    tag: ['input', 'select', 'textarea', 'button'].includes(item.meta.tag)
      ? item.meta.tag
      : 'other',
    role: item.meta.role === 'combobox' ? 'combobox' : 'other',
    type: ['text', 'tel', 'number', 'password', 'select-one', 'select-multiple'].includes(
      item.meta.type
    )
      ? item.meta.type
      : 'other',
    inShadowRoot: item.meta.inShadowRoot === true,
    frameId: state.interactionFrames.get(item.frame),
    frameKind: item.frame.parentFrame() ? 'embedded' : 'main',
    initialReason: point.reason || 'none',
    pointChecks,
    ...(point.blocker ? { blocker: point.blocker } : {})
  };
  state.interactionChecks ||= [];
  if (state.interactionChecks.length < 32) state.interactionChecks.push(trace);
  if (state.inspection) state.inspection.interactionChecks = state.interactionChecks;
  if (point.reason && ['outside_viewport', 'occluded'].includes(point.reason)) {
    if (!allowScroll) throw blocked(point.reason);
    timeout(deadline, state.signal);
    const scrollStarted = Date.now();
    try {
      await observedRead(
        () =>
          handle.scrollIntoViewIfNeeded({
            timeout: Math.min(500, timeout(deadline, state.signal))
          }),
        deadline,
        state.signal,
        state,
        'candidate_scroll',
        item.frame
      );
      trace.scroll = { state: 'completed', durationMs: Date.now() - scrollStarted };
    } catch (error) {
      trace.scroll = {
        state: 'failed',
        durationMs: Date.now() - scrollStarted,
        errorClass: scrollErrorClass(error)
      };
      if (state.readStopped)
        throw failure('CHECKOUT_CONTROL_READ_FAILED', '结账控件读取未完成', [key]);
      timeout(deadline, state.signal);
      if (closed(item.frame.page())) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭', [key]);
      state.scrollRecoveryUsed ||= new Set();
      if (!state.scrollRecoveryUsed.has(key)) {
        state.scrollRecoveryUsed.add(key);
        trace.recovery = 'requested';
        return { relocate: true, trace };
      }
      throw blocked('scroll_unavailable');
    }
    // Scrolling can mount duplicates, replace a field or open a dialog. Never
    // use the pre-scroll semantic snapshot to choose the field after that action.
    await observedRead(
      () =>
        handle.evaluate(
          (node) =>
            new Promise((resolve) =>
              node.ownerDocument.defaultView.requestAnimationFrame(() => resolve())
            )
        ),
      deadline,
      state.signal,
      state,
      'scroll_render',
      item.frame
    );
    const { items, inspection } = await readControlsOnce(item.frame.page(), deadline, state);
    if (inspectionCode(inspection))
      throw failure(inspectionCode(inspection), '结账控件读取未完成', [key]);
    const matches = candidatesFor(items, key);
    if (matches.length > 1)
      throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}有多个可见候选，未继续填写`, [
        key
      ]);
    if (
      matches.length !== 1 ||
      matches[0].frame !== item.frame ||
      !(await readWithin(
        () => matches[0].el.evaluateAll((nodes, original) => nodes.includes(original), handle),
        deadline,
        state.signal,
        'control_read',
        FRAME_READ_MS,
        state,
        item.frame,
        'candidate_identity'
      ))
    )
      throw blocked('page_changed');
    point = await readPoint();
    trace.afterScrollReason = point.reason || 'none';
  }
  if (point.reason) throw blocked(point.reason);
}
async function uniqueCandidate(items, key, deadline, state, allowScroll = true) {
  const matches = candidatesFor(items, key);
  if (state.formStep) state.formStep.candidateCount = matches.length;
  if (matches.length > 1)
    throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}有多个可见候选，未继续填写`, [key]);
  const item = matches[0];
  const step = state.formStep;
  if (step) {
    step.candidateCount = matches.length;
    if (item) {
      state.formFrames ||= new Map();
      if (!state.formFrames.has(item.frame))
        state.formFrames.set(item.frame, state.formFrames.size + 1);
      Object.assign(step, {
        frameId: state.formFrames.get(item.frame),
        frameKind: item.frame.parentFrame() ? 'embedded' : 'main',
        tag: ['input', 'select', 'textarea'].includes(item.meta.tag) ? item.meta.tag : 'other',
        role: item.meta.role === 'combobox' ? 'combobox' : null,
        inShadowRoot: item.meta.inShadowRoot === true,
        readOnly: item.meta.readOnly === true,
        locatorKind: item.locatorKind
      });
      if (step.phase === 'locate') step.phase = 'precheck';
    }
  }
  if (item) {
    const eligible = [];
    const handles = await readWithin(
      () => item.el.elementHandles(),
      deadline,
      state.signal,
      'candidate_handles',
      state.readBudgetMs,
      state,
      item.frame
    );
    try {
      const readDeadline = Math.min(deadline, Date.now() + (state.readBudgetMs || FRAME_READ_MS));
      for (const handle of handles)
        if (
          await readWithin(
            () => handle.evaluate(elementRendered, { control: true }),
            readDeadline,
            state.signal,
            'candidate_eligibility',
            state.readBudgetMs,
            state,
            item.frame
          )
        )
          eligible.push(handle);
      if (step) {
        step.eligibleCount = eligible.length;
        if (eligible.length === 1) step.visible = true;
      }
      if (eligible.length !== 1)
        throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}无法唯一定位，未继续填写`, [
          key
        ]);
      const interaction = await candidateInteraction(
        item,
        eligible[0],
        key,
        deadline,
        state,
        allowScroll
      );
      if (interaction?.relocate) {
        // The failed scroll has settled. Re-read once, without another scroll,
        // and never fill/select/click using the discarded original handle.
        try {
          const fresh = await readControlsOnce(item.frame.page(), deadline, state);
          const code = inspectionCode(fresh.inspection);
          if (code) throw failure(code, '结账控件读取未完成', [key]);
          const next = await uniqueCandidate(fresh.items, key, deadline, state, false);
          if (!next) throw failure('CHECKOUT_CONTROL_BLOCKED', `${labels[key]}重新定位失败`, [key]);
          interaction.trace.recovery = 'ready';
          interaction.trace.frameChanged = next.frame !== item.frame;
          return next;
        } catch (error) {
          interaction.trace.recovery =
            error.code === 'CHECKOUT_CONTROL_READ_FAILED' ? 'read_incomplete' : 'blocked';
          error.interactionRecovery = true;
          throw error;
        }
      }
      state.handles ||= new Set();
      state.handles.add(eligible[0]);
      return { ...item, el: eligible[0] };
    } catch (error) {
      if (error.code === 'CHECKOUT_FORM_TIMEOUT' && Date.now() < deadline)
        throw Object.assign(failure('CHECKOUT_CONTROL_READ_FAILED', '结账控件读取未完成'), {
          readPhase: error.readPhase || 'candidate_eligibility'
        });
      throw error;
    } finally {
      for (const handle of handles)
        if (!state.handles?.has(handle)) handle.dispose().catch(() => {});
    }
  }
  return null;
}
function releaseHandles(state) {
  for (const handle of state.handles || []) handle.dispose().catch(() => {});
  state.handles?.clear();
}
async function locateOnce(page, key, deadline, state) {
  const { items, inspection } = await readControlsOnce(page, deadline, state);
  const code = inspectionCode(inspection);
  if (code)
    throw Object.assign(failure(code, '结账控件读取未完成', [key]), {
      readPhase: inspection.readPhase || 'frame_scan'
    });
  return uniqueCandidate(items, key, deadline, state);
}
async function locate(page, key, deadline, state = {}) {
  return fieldStep(state, key, 'locate', () =>
    freshRead(page, deadline, state, () => locateOnce(page, key, deadline, state))
  );
}
async function readField(page, key, deadline, state, phase = 'readback') {
  return fieldStep(state, key, phase, () =>
    freshRead(page, deadline, state, async () => {
      const item = await locateOnce(page, key, deadline, state);
      return { item, current: item ? await value(item, deadline, state) : null };
    })
  );
}
async function value(item, deadline, state = {}) {
  timeout(deadline, state.signal);
  return readWithin(
    () =>
      item.el.evaluate((n) => ({
        value:
          n.getAttribute('role') === 'combobox' &&
          !['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName)
            ? n.getAttribute('aria-valuetext') || n.value || n.textContent || ''
            : (n.value ?? n.getAttribute('aria-valuetext') ?? n.textContent ?? ''),
        label: n.tagName === 'SELECT' ? n.selectedOptions[0]?.textContent || '' : '',
        valid: n.getAttribute('aria-invalid') !== 'true' && (!n.validity || n.validity.valid)
      })),
    deadline,
    state.signal,
    'value',
    state.readBudgetMs
  );
}
function matches(key, actual, expected) {
  if (key === 'month')
    return String(actual).replace(/^0+/, '') === String(expected).replace(/^0+/, '');
  if (key === 'year') return String(actual).slice(-2) === String(expected).slice(-2);
  if (key === 'number' || key === 'cvc' || key === 'expiry')
    return String(actual).replace(/\D/g, '') === String(expected).replace(/\D/g, '');
  if (key === 'country') return countryCode(actual) === countryCode(expected);
  if (key === 'state') return stateName(actual) === stateName(expected);
  return normalize(actual) === normalize(expected);
}
async function expandBilling(page, deadline, state) {
  const revision = state.countryRevision || 0;
  if (state.expandedAtCountry === revision) return;
  const { items } = await freshRead(page, deadline, state, async () => {
    const snapshot = await readControlsOnce(page, deadline, state);
    const code = inspectionCode(snapshot.inspection);
    if (code) throw failure(code, '账单控件读取未完成', ['line1']);
    return snapshot;
  });
  if (items.some(({ meta }) => score(meta, 'line1') > 0)) return;
  const handles = [],
    candidates = [];
  try {
    for (const frame of page.frames()) {
      if (!(await frameVisible(frame, deadline, state.signal))) continue;
      const entries = await readWithin(
        () => frame.locator('button,[role="button"],a,summary').elementHandles(),
        deadline,
        state.signal
      );
      handles.push(...entries);
      for (const handle of entries) {
        if (!(await readWithin(() => handle.evaluate(elementRendered), deadline, state.signal)))
          continue;
        const eligible = await readWithin(
          () =>
            handle.evaluate((n) => {
              if (
                n.matches(':disabled') ||
                n.closest('[aria-disabled="true"],[inert]') ||
                n.getAttribute('aria-expanded') === 'true' ||
                n.type === 'submit'
              )
                return false;
              if (
                n.tagName === 'A' &&
                n.getAttribute('href') &&
                !n.getAttribute('href').startsWith('#')
              )
                return false;
              if (n.tagName === 'SUMMARY' && n.parentElement?.open) return false;
              const label = (n.getAttribute('aria-label') || n.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();
              if (
                !/^(?:Billing address|Add billing address|Enter address manually|Enter billing address manually|账单地址|添加账单地址|手动输入地址|手动填写地址)$/i.test(
                  label
                )
              )
                return false;
              const ids = (n.getAttribute('aria-controls') || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean);
              return !ids.length || ids.every((id) => n.ownerDocument.getElementById(id));
            }),
          deadline,
          state.signal
        );
        if (eligible) candidates.push(handle);
      }
    }
    if (candidates.length > 1)
      throw failure('CHECKOUT_CONTROL_AMBIGUOUS', '账单地址有多个可见展开入口', ['line1']);
    if (candidates.length === 1) {
      timeout(deadline, state.signal);
      state.expandedAtCountry = revision;
      await within(
        () => candidates[0].click({ timeout: timeout(deadline, state.signal) }),
        deadline,
        state.signal
      );
    }
  } finally {
    for (const handle of handles) handle.dispose().catch(() => {});
  }
}
async function selectBoundBillingOption(item, key, expected, deadline, state) {
  const ids = await readWithin(
    () =>
      item.el.evaluate((n) => [
        ...new Set(
          `${n.getAttribute('aria-controls') || ''} ${n.getAttribute('aria-owns') || ''}`
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        )
      ]),
    deadline,
    state.signal
  );
  if (!ids.length)
    throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}下拉框没有明确绑定的选项区域`, [
      key
    ]);
  const roots = ids.map((id) => item.frame.locator(`[id=${JSON.stringify(id)}]`));
  try {
    for (const root of roots) {
      if ((await readWithin(() => root.count(), deadline, state.signal)) !== 1)
        throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}选项区域无法唯一定位`, [key]);
      await within(
        () => root.waitFor({ state: 'visible', timeout: timeout(deadline, state.signal) }),
        deadline,
        state.signal
      );
    }
    while (Date.now() < deadline) {
      const handles = [],
        candidates = [];
      try {
        for (const root of roots) {
          handles.push(...(await readWithin(() => root.elementHandles(), deadline, state.signal)));
          handles.push(
            ...(await readWithin(() => root.locator('*').elementHandles(), deadline, state.signal))
          );
        }
        for (const handle of handles) {
          if (!(await readWithin(() => handle.evaluate(elementRendered), deadline, state.signal)))
            continue;
          const option = await readWithin(
            () =>
              handle.evaluate((n) => {
                if (
                  n.matches(':disabled') ||
                  n.closest('[aria-disabled="true"],[inert]') ||
                  n.type === 'submit' ||
                  ['INPUT', 'TEXTAREA', 'SELECT', 'FORM', 'SCRIPT', 'STYLE'].includes(n.tagName)
                )
                  return null;
                const text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
                const explicit = n.matches(
                  '[role="option"],button,[role="menuitem"],[data-value],option'
                );
                const leaf = !Array.from(n.children).some(
                  (child) => (child.textContent || '').replace(/\s+/g, ' ').trim() === text
                );
                return explicit || leaf
                  ? {
                      text,
                      value: n.getAttribute('data-value') || n.getAttribute('value') || '',
                      explicit
                    }
                  : null;
              }),
            deadline,
            state.signal
          );
          if (
            option &&
            (matches(key, option.text, expected) ||
              (option.value && matches(key, option.value, expected)))
          )
            candidates.push({ handle, explicit: option.explicit });
        }
        const explicit = candidates.filter((candidate) => candidate.explicit);
        const matched = explicit.length ? explicit : candidates;
        if (matched.length > 1)
          throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}有多个匹配选项`, [key]);
        if (matched.length === 1) {
          await within(
            () => matched[0].handle.click({ timeout: timeout(deadline, state.signal) }),
            deadline,
            state.signal
          );
          return;
        }
      } finally {
        for (const handle of handles) handle.dispose().catch(() => {});
      }
      await within(
        () => item.frame.page().waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now()))),
        deadline,
        state.signal
      );
    }
    timeout(deadline, state.signal);
  } catch (error) {
    if (error.code) throw error;
    throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}绑定的选项未能唯一确认`, [key]);
  }
}
async function write(page, key, expected, deadline, state = {}) {
  const { item, current } = await readField(page, key, deadline, state, 'locate');
  if (!item) return false;
  if (
    current.valid &&
    (matches(key, current.value, expected) ||
      (current.label && matches(key, current.label, expected)))
  )
    return true;
  return fieldStep(state, key, 'input', async () => {
    state.formStep.method =
      item.meta.tag === 'select'
        ? 'select_option'
        : item.meta.role === 'combobox'
          ? 'combobox'
          : 'fill';
    if (item.meta.tag === 'select') {
      const options = await readWithin(
        () =>
          item.el.evaluate((n) =>
            Array.from(n.options || []).map((option) => ({
              value: option.value,
              label: option.textContent || ''
            }))
          ),
        deadline,
        state.signal
      );
      const option = options.find(
        (o) => matches(key, o.value, expected) || matches(key, o.label, expected)
      );
      if (!option) throw new Error(`${labels[key]}没有与资料一致的选项`);
      await item.el.selectOption(option.value, { timeout: timeout(deadline, state.signal) });
    } else if (
      (item.meta.role === 'combobox' && !['input', 'textarea'].includes(item.meta.tag)) ||
      (['country', 'state'].includes(key) &&
        (item.meta.role === 'combobox' ||
          (await readWithin(
            () =>
              item.el.evaluate((n) =>
                Boolean(n.getAttribute('aria-controls') || n.getAttribute('aria-owns'))
              ),
            deadline,
            state.signal
          ))))
    ) {
      if (item.meta.readOnly && item.meta.tag === 'input') {
        await item.el.press('ArrowDown', { timeout: timeout(deadline, state.signal) });
      } else {
        await item.el.click({ timeout: timeout(deadline, state.signal) });
        if (item.meta.tag === 'input')
          await item.el.fill(String(expected), { timeout: timeout(deadline, state.signal) });
      }
      await selectBoundBillingOption(item, key, expected, deadline, state);
    } else {
      const maxLength =
        key === 'year'
          ? await readWithin(() => item.el.getAttribute('maxlength'), deadline, state.signal)
          : null;
      const text =
        key === 'year'
          ? maxLength === '2'
            ? String(expected).slice(-2)
            : String(expected).length === 2
              ? '20' + expected
              : String(expected)
          : String(expected);
      await item.el.fill(text, { timeout: timeout(deadline, state.signal) });
      // An input handler may replace this exact node. Never fall back to another
      // node for Tab; the next semantic readback will rediscover its replacement.
      if (await readWithin(() => item.el.evaluate((n) => n.isConnected), deadline, state.signal))
        await item.el.press('Tab', { timeout: timeout(deadline, state.signal) });
    }
    if (key === 'country') state.countryRevision = (state.countryRevision || 0) + 1;
    return true;
  });
}
async function verify(page, expected, deadline, providedState) {
  const state = providedState || {};
  const missing = [];
  try {
    for (const [key, wanted] of Object.entries(expected)) {
      state.pending?.add(key);
      const { item, current: actual } = await readField(page, key, deadline, state);
      if (!item) {
        missing.push(key);
        continue;
      }
      if (
        !actual.valid ||
        !(
          matches(key, actual.value, wanted) ||
          (actual.label && matches(key, actual.label, wanted))
        )
      )
        missing.push(key);
      else state.pending?.delete(key);
      const step = state.formSteps?.at(-1);
      if (step?.field === key && step.phase === 'readback') step.matched = !missing.includes(key);
    }
    return missing;
  } finally {
    if (!providedState) releaseHandles(state);
  }
}
async function fill(page, expected, deadline, state) {
  let missing = Object.keys(expected);
  while (Date.now() < deadline) {
    for (const key of missing) {
      try {
        if (state.billing && key === 'line1') await expandBilling(page, deadline, state);
        await write(page, key, expected[key], deadline, state);
      } catch (e) {
        if (e.code || /多个|选项/.test(e.message)) throw e;
      }
    }
    missing = await verify(page, expected, deadline, state);
    if (!missing.length)
      return {
        ok: true,
        filled: Object.fromEntries(Object.keys(expected).map((key) => [key, true]))
      };
    await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  throw failure('CHECKOUT_FORM_TIMEOUT', '填表超过本次总时限', missing);
}
async function diagnostic(page, { deadline = Date.now() + 2000, signal } = {}) {
  const state = { signal };
  await readControlsOnce(page, deadline, state);
  return state.controls || [];
}
function failedResult(page, error, deadline, state) {
  const inspection = { ...inspectionState(page, deadline, state.signal), ...state.inspection };
  inspection.pageClosed = closed(page);
  inspection.aborted = state.signal?.aborted === true;
  inspection.timedOut = Date.now() >= deadline || error.code === 'CHECKOUT_FORM_TIMEOUT';
  if (
    ['frame_scan', 'candidate_handles', 'candidate_eligibility', 'value', 'control_read'].includes(
      error.readPhase
    )
  )
    inspection.readPhase = error.readPhase;
  if (error.code === 'CHECKOUT_CONTROL_READ_FAILED' && !inspection.framesFailed)
    inspection.framesFailed = 1;
  const controlled = new Set([
    'CHECKOUT_PAGE_CLOSED',
    'CHECKOUT_FORM_ABORTED',
    'CHECKOUT_FORM_TIMEOUT',
    'CHECKOUT_CONTROL_READ_FAILED',
    'CHECKOUT_CONTROL_AMBIGUOUS',
    'CHECKOUT_CONTROL_BLOCKED',
    'CHECKOUT_FORM_DATA_MISSING',
    'CHECKOUT_CONTENT_LOAD_FAILED'
  ]);
  const code =
    inspectionCode(inspection) ||
    (controlled.has(error.code) ? error.code : 'CHECKOUT_CONTROL_READ_FAILED');
  if (code === 'CHECKOUT_CONTROL_READ_FAILED')
    inspection.framesFailed = Math.max(1, inspection.framesFailed);
  if (inspectionCode(inspection)) inspection.complete = false;
  const specific = [
    'CHECKOUT_CONTROL_AMBIGUOUS',
    'CHECKOUT_CONTROL_BLOCKED',
    'CHECKOUT_FORM_DATA_MISSING'
  ].includes(code);
  const pending = [...(state.pending || [])];
  return {
    ok: false,
    errorCode: code,
    error:
      code === 'CHECKOUT_PAGE_CLOSED'
        ? '结账页面已关闭，未完成填表'
        : code === 'CHECKOUT_CONTENT_LOAD_FAILED'
          ? '结账内容加载失败，未完成填表'
          : code === 'CHECKOUT_FORM_ABORTED'
            ? '本次填表已停止'
            : code === 'CHECKOUT_FORM_TIMEOUT'
              ? '填表超过本次总时限'
              : specific
                ? error.message
                : '结账控件读取或校验失败，未完成填表',
    missing:
      specific && error.failedFields?.length
        ? error.failedFields
        : pending.length
          ? pending
          : error.failedFields || [...(state.fields || [])],
    controls: state.controls || [],
    inspection,
    formDiagnostics: {
      inspection: {
        ...inspection,
        readFailures: (inspection.readFailures || []).map((row) => ({ ...row })),
        frameSkipCounts: { ...inspection.frameSkipCounts },
        controlCounts: { ...inspection.controlCounts },
        controlRejectCounts: { ...inspection.controlRejectCounts },
        interactionRejectCounts: { ...inspection.interactionRejectCounts }
      },
      steps: (state.formSteps || []).map((step) => ({ ...step }))
    }
  };
}
async function guarded(page, action, deadline, state) {
  try {
    if (closed(page)) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭');
    return await within(action, deadline, state.signal);
  } catch (e) {
    let observed = e;
    if (!closed(page) && !state.signal?.aborted && Date.now() < deadline) {
      try {
        if (await loadFailed(page, deadline, state.signal)) {
          state.inspection = { ...state.inspection, contentLoadFailed: true };
          observed = failure('CHECKOUT_CONTENT_LOAD_FAILED', '结账内容加载失败');
        }
      } catch (probeError) {
        // An incomplete diagnostic read is not evidence of visible load failure.
        // Preserve the original field error unless the task itself has stopped.
        if (
          ['CHECKOUT_PAGE_CLOSED', 'CHECKOUT_FORM_ABORTED', 'CHECKOUT_FORM_TIMEOUT'].includes(
            probeError.code
          )
        )
          observed = probeError;
      }
    }
    return failedResult(page, observed, deadline, state);
  } finally {
    releaseHandles(state);
  }
}
async function fillCard(page, card, { deadline = Date.now() + 120000, signal } = {}) {
  const state = {
    signal,
    fields: ['number', 'expiry', 'cvc'],
    pending: new Set(['number', 'expiry', 'cvc'])
  };
  return guarded(
    page,
    async () => {
      if (!card?.number || !card?.expiry || !card?.cvc)
        throw failure(
          'CHECKOUT_FORM_DATA_MISSING',
          '卡片资料缺失',
          state.fields.filter((key) => !card?.[key])
        );
      const expected = { number: String(card.number).replace(/\D/g, ''), cvc: String(card.cvc) };
      const split = String(card.expiry).match(/^(\d{2})\/?(\d{2}|\d{4})$/);
      if (!split) throw failure('CHECKOUT_FORM_DATA_MISSING', '有效期资料无效', ['expiry']);
      // Some elements reveal the expiry only after the number has been entered.
      while (Date.now() < deadline) {
        if (
          (await write(page, 'number', expected.number, deadline, state)) &&
          !(await verify(page, { number: expected.number }, deadline, state)).length
        )
          break;
        await within(
          () => page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now()))),
          deadline,
          signal
        );
      }
      // Wait for either a combined expiry control or both explicitly labelled parts.
      while (Date.now() < deadline) {
        if (await locate(page, 'expiry', deadline, state)) {
          expected.expiry = `${split[1]}/${split[2].slice(-2)}`;
          break;
        }
        if (
          (await locate(page, 'month', deadline, state)) &&
          (await locate(page, 'year', deadline, state))
        ) {
          expected.month = split[1];
          expected.year = split[2];
          state.pending.delete('expiry');
          state.pending.add('month');
          state.pending.add('year');
          break;
        }
        await within(
          () => page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now()))),
          deadline,
          signal
        );
      }
      if (!expected.expiry && !expected.month)
        throw failure('CHECKOUT_FORM_TIMEOUT', '有效期控件未在总时限内出现', ['expiry']);
      return fill(page, expected, deadline, state);
    },
    deadline,
    state
  );
}
async function fillBilling(page, address, name, { deadline = Date.now() + 120000, signal } = {}) {
  const fields = [
    'country',
    'line1',
    'city',
    'postal',
    'name',
    ...(address?.state ? ['state'] : [])
  ];
  const state = { signal, fields, pending: new Set(fields), billing: true };
  return guarded(
    page,
    async () => {
      const expected = {
        country: address?.country || address?.region,
        line1: address?.line1,
        city: address?.city,
        postal: address?.postal_code,
        name
      };
      const absent = Object.entries(expected)
        .filter(([, v]) => !String(v ?? '').trim())
        .map(([key]) => key);
      if (absent.length)
        throw failure(
          'CHECKOUT_FORM_DATA_MISSING',
          `账单资料缺失：${absent.map((key) => labels[key]).join('、')}`,
          absent
        );
      if (address.state) expected.state = address.state;
      if (['us', 'ca', 'au'].includes(countryCode(expected.country)) && !expected.state)
        throw failure('CHECKOUT_FORM_DATA_MISSING', '账单资料缺失：州/省', ['state']);
      // Country changes can replace all address controls. Re-discover after every write.
      return fill(page, expected, deadline, state);
    },
    deadline,
    state
  );
}
async function inspectCardReadiness(
  page,
  { deadline = Date.now() + 120000, signal, onRead, stopOnReadFailure = false } = {}
) {
  const state = {
    signal,
    onRead,
    stopOnReadFailure,
    fields: ['number'],
    pending: new Set(['number'])
  };
  try {
    const ready = await freshRead(page, deadline, state, async () => {
      const item = await locateOnce(page, 'number', deadline, state);
      return Boolean(
        item &&
        (await readWithin(
          () => item.el.isEditable(),
          deadline,
          signal,
          'candidate_eligibility',
          state.readBudgetMs,
          state,
          item.frame
        ))
      );
    });
    return {
      ready,
      missing: ready ? [] : ['number'],
      code: ready ? 'CHECKOUT_CARD_READY' : 'CHECKOUT_CARD_NOT_READY',
      controls: state.controls,
      inspection: state.inspection
    };
  } catch (error) {
    const result = failedResult(page, error, deadline, state);
    return {
      ready: false,
      missing: ['number'],
      code: result.errorCode,
      controls: result.controls,
      inspection: result.inspection
    };
  } finally {
    releaseHandles(state);
  }
}
// Failure-only, read-only comparison. It never admits a candidate or changes the
// original failure. Every row comes from the same metadata snapshot under both
// visibility definitions; no field value, selector, URL or frame identity leaves it.
async function inspectCardExclusions(page, { deadline = Date.now() + 2000, signal } = {}) {
  const result = {
    complete: false,
    shadowCoverage: 'open_only',
    framesInspected: 0,
    framesFailed: 0,
    timedOut: false,
    aborted: false,
    pageClosed: false,
    truncated: false,
    numberComparison: { semanticEligible: 0, geometryEditable: 0 },
    failures: [],
    rows: []
  };
  const recordFailure = (phase, error) => {
    const reason = signal?.aborted
      ? 'aborted'
      : closed(page)
        ? 'closed'
        : error?.code === 'CHECKOUT_FORM_TIMEOUT'
          ? 'timeout'
          : /detached|execution context was destroyed/i.test(String(error?.message || ''))
            ? 'detached'
            : 'read_failed';
    const prior = result.failures.find((row) => row.phase === phase && row.reason === reason);
    if (prior) prior.count = Math.min(10000, prior.count + 1);
    else result.failures.push({ phase, reason, count: 1 });
  };
  try {
    const frames = page.frames();
    for (const frame of frames.slice(0, 64)) {
      const readDeadline = Math.min(deadline, Date.now() + FRAME_READ_MS);
      let phase = 'frame_owner';
      try {
        timeout(deadline, signal);
        if (closed(page)) break;
        let frameReason = null,
          frameAt = 'none',
          frameBoxVisible = true;
        for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
          const owner = await within(() => current.frameElement(), readDeadline, signal);
          try {
            const detail = await within(
              () => owner.evaluate(elementRendered, { describe: true, interaction: true }),
              readDeadline,
              signal
            );
            frameBoxVisible &&= detail.boxVisible;
            if (!frameReason && detail.reason) {
              frameReason = detail.reason;
              frameAt = detail.at;
            }
          } finally {
            owner.dispose().catch(() => {});
          }
        }
        phase = 'control_snapshot';
        const snapshot = await within(
          () =>
            frame
              .locator('input,select,textarea,[role="combobox"]')
              .evaluateAll(elementRendered, { snapshot: true, includeRejected: true }),
          readDeadline,
          signal
        );
        result.framesInspected++;
        const controls = [
          ...snapshot.metas.map((meta) => ({ meta, reason: null, at: 'none' })),
          ...snapshot.rejectedMetas
        ];
        for (const item of controls) {
          const fields = Object.keys(rules).filter((field) => score(item.meta, field) > 0);
          const reason = frameReason || item.reason || 'eligible';
          const boxVisible = frameBoxVisible && item.meta.comparison.boxVisible;
          const editable = item.meta.comparison.editable;
          if (fields.includes('number')) {
            result.numberComparison.semanticEligible += Number(reason === 'eligible' && editable);
            result.numberComparison.geometryEditable += Number(boxVisible && editable);
            for (const key of ['semanticEligible', 'geometryEditable'])
              if (result.numberComparison[key] > 10000) {
                result.numberComparison[key] = 10000;
                result.truncated = true;
              }
          }
          for (const field of fields) {
            const row = {
              field,
              source: frameReason ? 'frame' : 'control',
              reason,
              at: frameReason ? frameAt : item.at,
              frameKind: frame.parentFrame() ? 'embedded' : 'main',
              boxVisible,
              editable
            };
            const same = result.rows.find((other) =>
              Object.keys(row).every((key) => other[key] === row[key])
            );
            if (same && same.count < 10000) same.count++;
            else if (!same && result.rows.length < 64) result.rows.push({ ...row, count: 1 });
            else result.truncated = true;
          }
        }
      } catch (error) {
        result.framesFailed++;
        recordFailure(phase, error);
        result.timedOut ||= error?.code === 'CHECKOUT_FORM_TIMEOUT' && readDeadline === deadline;
        if (result.timedOut || signal?.aborted || Date.now() >= deadline || closed(page)) break;
      }
    }
    result.truncated ||= frames.length > 64;
  } catch (error) {
    result.framesFailed++;
    recordFailure('frame_scan', error);
  }
  result.timedOut ||= Date.now() >= deadline;
  result.aborted = signal?.aborted === true;
  result.pageClosed = closed(page);
  result.complete =
    !result.framesFailed &&
    !result.timedOut &&
    !result.aborted &&
    !result.pageClosed &&
    !result.truncated;
  return result;
}
async function loadFailed(page, deadline, signal, options = {}) {
  const state = {
    signal,
    onRead: options.onRead,
    stopOnReadFailure: options.stopOnReadFailure === true
  };
  return freshRead(page, deadline, state, async () => {
    const inspection = inspectionState(page, deadline, signal);
    state.inspection = inspection;
    let readDeadline = deadline;
    try {
      if (closed(page)) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭');
      const frames = page.frames();
      for (const frame of frames) {
        timeout(deadline, signal);
        if (closed(page)) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭');
        readDeadline = Math.min(deadline, Date.now() + state.readBudgetMs);
        if (!(await frameVisible(frame, readDeadline, signal, inspection, state))) {
          inspection.framesSkipped++;
          continue;
        }
        const visibleFailure = await frameLoadFailed(frame, readDeadline, signal, state);
        timeout(deadline, signal);
        if (closed(page)) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭');
        inspection.framesChecked++;
        if (visibleFailure) {
          inspection.contentLoadFailed = true;
          inspection.complete = true;
          return true;
        }
      }
      timeout(deadline, signal);
      if (closed(page)) throw failure('CHECKOUT_PAGE_CLOSED', '结账页面已关闭');
      inspection.complete = true;
      return false;
    } catch (error) {
      inspection.pageClosed = closed(page);
      inspection.aborted = signal?.aborted === true;
      inspection.timedOut =
        Date.now() >= deadline ||
        (error.code === 'CHECKOUT_FORM_TIMEOUT' && readDeadline === deadline);
      inspection.framesFailed++;
      inspection.readPhase = 'frame_scan';
      if (state.onRead) frameReadFailure(inspection, 'frame_scan', error, page, signal);
      const code = inspectionCode(inspection);
      throw Object.assign(failure(code, '结账加载状态读取未完成'), {
        readPhase: 'frame_scan',
        ...(error.readOperation ? { readOperation: error.readOperation } : {}),
        inspection
      });
    }
  });
}
async function checkoutPageLoadFailed(
  page,
  { deadline = Date.now() + 2000, signal, onRead, stopOnReadFailure = false } = {}
) {
  return loadFailed(page, deadline, signal, { onRead, stopOnReadFailure });
}
async function verifyCard(page, card, { deadline = Date.now() + 120000 } = {}) {
  const state = {};
  try {
    const expected = { number: String(card.number).replace(/\D/g, ''), cvc: String(card.cvc) };
    const parts = String(card.expiry).match(/^(\d{2})\/?(\d{2}|\d{4})$/);
    if (!parts) return ['expiry'];
    if (await locate(page, 'expiry', deadline, state))
      expected.expiry = `${parts[1]}/${parts[2].slice(-2)}`;
    else {
      expected.month = parts[1];
      expected.year = parts[2];
    }
    return await verify(page, expected, deadline, state);
  } finally {
    releaseHandles(state);
  }
}
async function stableDue(page, read, deadline) {
  let previous = null,
    stable = 0;
  while (Date.now() < deadline) {
    const due = await within(read(), deadline);
    const key = due ? `${due.currency}:${due.amount}` : null;
    stable = key && key === previous ? stable + 1 : 0;
    if (stable >= 3) return due;
    previous = key;
    await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  return null;
}
module.exports = {
  elementRendered,
  fillCard,
  fillBilling,
  diagnostic,
  verify,
  verifyCard,
  matches,
  stableDue,
  inspectCardReadiness,
  inspectCardExclusions,
  checkoutPageLoadFailed
};
