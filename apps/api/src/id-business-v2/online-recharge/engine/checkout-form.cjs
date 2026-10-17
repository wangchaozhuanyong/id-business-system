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
    contentLoadFailed: false,
    timedOut: Date.now() >= deadline,
    pageClosed: closed(page),
    aborted: signal?.aborted === true
  };
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
function elementRendered(element, { control = false } = {}) {
  if (
    control &&
    (element.matches(':disabled') ||
      (element.readOnly && element.getAttribute('role') !== 'combobox') ||
      (element.type === 'button' &&
        !(element.tagName === 'BUTTON' && element.getAttribute('role') === 'combobox')) ||
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
      ].includes(element.type))
  )
    return false;
  for (let n = element; n; n = n.parentElement || n.getRootNode()?.host) {
    const style = n.ownerDocument.defaultView.getComputedStyle(n);
    if (
      n.hidden ||
      n.inert ||
      n.getAttribute('aria-hidden') === 'true' ||
      (control && n.getAttribute('aria-disabled') === 'true') ||
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility) ||
      Number(style.opacity) === 0 ||
      style.contentVisibility === 'hidden'
    )
      return false;
  }
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}
async function frameVisible(frame, deadline, signal) {
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    const owner = await within(() => current.frameElement(), deadline, signal);
    try {
      const visible = await within(() => owner.evaluate(elementRendered), deadline, signal);
      if (!visible) return false;
    } finally {
      // Releasing a handle must not extend a failed frame's read budget.
      owner.dispose().catch(() => {});
    }
  }
  return true;
}
async function frameLoadFailed(frame, deadline, signal) {
  const matches = frame.getByText('Content failed to load', { exact: true });
  const count = await within(() => matches.count(), deadline, signal);
  for (let index = 0; index < count; index++)
    if (await within(() => matches.nth(index).evaluate(elementRendered), deadline, signal))
      return true;
  return false;
}
async function readControlsOnce(page, deadline, state) {
  const inspection = inspectionState(page, deadline, state.signal);
  const result = [];
  let frames = [];
  if (!inspectionCode(inspection)) {
    try {
      frames = page.frames();
    } catch {
      inspection.framesFailed++;
      inspection.readPhase = 'frame_scan';
    }
  }
  for (const frame of frames) {
    inspection.timedOut = Date.now() >= deadline;
    inspection.pageClosed = closed(page);
    inspection.aborted = state.signal?.aborted === true;
    if (inspection.timedOut || inspection.pageClosed || inspection.aborted) break;
    const frameDeadline = Math.min(deadline, Date.now() + (state.readBudgetMs || FRAME_READ_MS));
    try {
      if (!(await frameVisible(frame, frameDeadline, state.signal))) {
        inspection.framesSkipped++;
        continue;
      }
      if (await frameLoadFailed(frame, frameDeadline, state.signal)) {
        inspection.contentLoadFailed = true;
        break;
      }
      const all = frame.locator('input,select,textarea,[role="combobox"]');
      const metas = await within(
        () =>
          all.evaluateAll((nodes) =>
            nodes
              .map((n, index) => {
                const style = n.ownerDocument.defaultView.getComputedStyle(n),
                  box = n.getBoundingClientRect();
                if (
                  !box.width ||
                  !box.height ||
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  n.matches(':disabled') ||
                  n.getAttribute('aria-disabled') === 'true' ||
                  (n.readOnly && n.getAttribute('role') !== 'combobox') ||
                  (n.type === 'button' &&
                    !(n.tagName === 'BUTTON' && n.getAttribute('role') === 'combobox')) ||
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
                  ].includes(n.type) ||
                  n.closest('[aria-hidden="true"],[inert]')
                )
                  return null;
                for (
                  let parent = n;
                  parent;
                  parent = parent.parentElement || parent.getRootNode()?.host
                ) {
                  const parentStyle = parent.ownerDocument.defaultView.getComputedStyle(parent);
                  if (
                    parent.hidden ||
                    parent.inert ||
                    parent.getAttribute('aria-hidden') === 'true' ||
                    parent.getAttribute('aria-disabled') === 'true' ||
                    parentStyle.display === 'none' ||
                    ['hidden', 'collapse'].includes(parentStyle.visibility) ||
                    Number(parentStyle.opacity) === 0 ||
                    parentStyle.contentVisibility === 'hidden'
                  )
                    return null;
                }
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
                      .map((id) => n.ownerDocument.getElementById(id)?.textContent || '')
                      .join(' ')
                      .trim() ||
                    Array.from(n.labels || [])
                      .map((l) => l.textContent)
                      .join(' ') ||
                    ''
                  ).slice(0, 160),
                  tag: n.tagName.toLowerCase(),
                  role: n.getAttribute('role'),
                  scope,
                  owner,
                  readOnly: Boolean(n.readOnly),
                  required: n.required || n.getAttribute('aria-required') === 'true'
                };
              })
              .filter(Boolean)
          ),
        frameDeadline,
        state.signal
      );
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
              `${meta.tag}[${attribute[0]}=${JSON.stringify(attribute[1])}]:visible:not(:disabled,[inert],[inert] *,[aria-hidden="true"],[aria-hidden="true"] *,[readonly]:not([role="combobox"]))`
            )
          : meta.label
            ? root.getByLabel(meta.label, { exact: true })
            : meta.placeholder
              ? root.getByPlaceholder(meta.placeholder, { exact: true })
              : null;
        if (el) result.push({ frame, el, meta });
      }
    } catch {
      inspection.framesFailed++;
      inspection.readPhase = 'frame_scan';
    }
  }
  inspection.timedOut = Date.now() >= deadline;
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
  readBudgetMs = FRAME_READ_MS
) {
  try {
    return await within(operation, Math.min(deadline, Date.now() + readBudgetMs), signal);
  } catch (error) {
    if (error.code === 'CHECKOUT_FORM_TIMEOUT' && Date.now() < deadline)
      throw Object.assign(failure('CHECKOUT_CONTROL_READ_FAILED', '结账控件读取未完成'), {
        readPhase
      });
    error.readPhase = readPhase;
    throw error;
  }
}
async function uniqueCandidate(items, key, deadline, state) {
  const matches = candidatesFor(items, key);
  if (matches.length > 1)
    throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}有多个可见候选，未继续填写`, [key]);
  const item = matches[0];
  if (item) {
    const eligible = [];
    const handles = await readWithin(
      () => item.el.elementHandles(),
      deadline,
      state.signal,
      'candidate_handles',
      state.readBudgetMs
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
            state.readBudgetMs
          )
        )
          eligible.push(handle);
      if (eligible.length !== 1)
        throw failure('CHECKOUT_CONTROL_AMBIGUOUS', `${labels[key]}无法唯一定位，未继续填写`, [
          key
        ]);
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
  return freshRead(page, deadline, state, () => locateOnce(page, key, deadline, state));
}
async function readField(page, key, deadline, state) {
  return freshRead(page, deadline, state, async () => {
    const item = await locateOnce(page, key, deadline, state);
    return { item, current: item ? await value(item, deadline, state) : null };
  });
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
  const { item, current } = await readField(page, key, deadline, state);
  if (!item) return false;
  if (
    current.valid &&
    (matches(key, current.value, expected) ||
      (current.label && matches(key, current.label, expected)))
  )
    return true;
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
    'CHECKOUT_FORM_DATA_MISSING',
    'CHECKOUT_CONTENT_LOAD_FAILED'
  ]);
  const code =
    inspectionCode(inspection) ||
    (controlled.has(error.code) ? error.code : 'CHECKOUT_CONTROL_READ_FAILED');
  if (code === 'CHECKOUT_CONTROL_READ_FAILED')
    inspection.framesFailed = Math.max(1, inspection.framesFailed);
  if (inspectionCode(inspection)) inspection.complete = false;
  const specific = ['CHECKOUT_CONTROL_AMBIGUOUS', 'CHECKOUT_FORM_DATA_MISSING'].includes(code);
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
    inspection
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
async function inspectCardReadiness(page, { deadline = Date.now() + 120000, signal } = {}) {
  const state = { signal, fields: ['number'], pending: new Set(['number']) };
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
          state.readBudgetMs
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
async function loadFailed(page, deadline, signal) {
  const state = { signal };
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
        if (!(await frameVisible(frame, readDeadline, signal))) {
          inspection.framesSkipped++;
          continue;
        }
        const visibleFailure = await frameLoadFailed(frame, readDeadline, signal);
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
      const code = inspectionCode(inspection);
      throw Object.assign(failure(code, '结账加载状态读取未完成'), {
        readPhase: 'frame_scan',
        inspection
      });
    }
  });
}
async function checkoutPageLoadFailed(page, { deadline = Date.now() + 2000, signal } = {}) {
  return loadFailed(page, deadline, signal);
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
  fillCard,
  fillBilling,
  diagnostic,
  verify,
  verifyCard,
  matches,
  stableDue,
  inspectCardReadiness,
  checkoutPageLoadFailed
};
