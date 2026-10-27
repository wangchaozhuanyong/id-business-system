'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const {
  fillCard,
  fillBilling,
  inspectCardReadiness,
  inspectCardExclusions,
  checkoutPageLoadFailed,
  diagnostic
} = require('../checkout-form.cjs');
const { assertPaymentLimit } = require('../payment-limit.cjs');
const card = { number: '4242424242424242', expiry: '12/30', cvc: '123' };
const address = {
  country: 'US',
  line1: '1 Synthetic Street',
  city: 'Synthetic',
  postal_code: '97201',
  state: 'Oregon'
};
const cardHtml =
  '<input autocomplete="email"><input autocomplete="cc-csc"><input autocomplete="cc-number"><input autocomplete="cc-exp">';
const addressHtml =
  '<input autocomplete="billing name"><input autocomplete="billing address-line1"><input autocomplete="billing address-level2"><input autocomplete="billing postal-code"><select autocomplete="billing address-level1"><option value="">Choose</option><option value="OR">Oregon</option></select>';
const countryHtml =
  '<select autocomplete="billing country"><option value="PH">Philippines</option><option value="US">United States</option></select>';
function interceptCountryScroll(t, page, scroll) {
  const frame = page.mainFrame(),
    locator = frame.locator;
  let calls = 0;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector.includes('[autocomplete="billing country"]')) {
      const handles = result.elementHandles.bind(result);
      result.elementHandles = async () => {
        const list = await handles();
        for (const handle of list)
          handle.scrollIntoViewIfNeeded = async () => {
            calls++;
            return scroll(handle);
          };
        return list;
      };
    }
    return result;
  };
  t.after(() => {
    frame.locator = locator;
  });
  return () => calls;
}
function interceptFrameScroll(t, frame, scroll) {
  const frameElement = frame.frameElement;
  let calls = 0;
  frame.frameElement = async function (...args) {
    const owner = await frameElement.apply(this, args);
    const nativeScroll = owner.scrollIntoViewIfNeeded.bind(owner);
    owner.scrollIntoViewIfNeeded = async (options) => {
      calls++;
      return scroll(owner, nativeScroll, options);
    };
    return owner;
  };
  t.after(() => {
    frame.frameElement = frameElement;
  });
  return () => calls;
}
let browser;
test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
});
test.after(async () => browser?.close());
async function pageFor(t, html) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => route.abort());
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(html);
  return page;
}
const iframe = (html) =>
  `<iframe style="width:900px;height:600px" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;

for (const nested of [false, true])
  test(`embedded billing outside the main viewport is filled through native scrolling, nested=${nested}`, async (t) => {
    const content = countryHtml + addressHtml;
    const page = await pageFor(
      t,
      '<div style="height:2000px"></div>' + iframe(nested ? iframe(content) : content)
    );
    const frame = page.frames().at(-1);
    const result = await fillBilling(page, address, 'Synthetic Name', {
      deadline: Date.now() + 4000
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await frame.locator('[autocomplete="billing country"]').inputValue(), 'US');
    assert.equal(
      await frame.locator('[autocomplete="billing address-line1"]').inputValue(),
      address.line1
    );
  });

test('embedded country reports the outer viewport that blocks it without selecting', async (t) => {
  const page = await pageFor(
    t,
    '<div style="height:2000px"></div>' + iframe(countryHtml + addressHtml)
  );
  const frame = page.frames()[1];
  const scrolls = interceptFrameScroll(t, frame, async () => {});
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_BLOCKED');
  const trace = result.inspection.interactionChecks[0];
  assert.equal(trace.initialReason, 'outside_viewport');
  assert.equal(trace.scroll.state, 'completed');
  assert.equal(trace.afterScrollReason, 'outside_viewport');
  assert.equal(scrolls(), 1);
  assert.equal(trace.pointChecks[0].scope, 'control');
  assert.equal(trace.pointChecks[0].reason, 'none');
  assert.equal(trace.pointChecks[1].scope, 'frame_owner');
  assert.equal(trace.pointChecks[1].reason, 'outside_viewport');
  assert.ok(trace.pointChecks[1].geometry.top > trace.pointChecks[1].geometry.viewportHeight);
  assert.equal(await frame.locator('[autocomplete="billing country"]').inputValue(), 'PH');
});

test('country visible inside an offscreen iframe scrolls the host without invoking a stuck inner scroll', async (t) => {
  const page = await pageFor(
    t,
    '<div style="height:1210px"></div>' + iframe(countryHtml + addressHtml)
  );
  const frame = page.frames()[1];
  const innerScrolls = interceptCountryScroll(t, { mainFrame: () => frame }, async () => {
    throw Object.assign(new Error('Synthetic inner scroll timeout'), { name: 'TimeoutError' });
  });
  const hostScrolls = interceptFrameScroll(t, frame, (_owner, nativeScroll, options) =>
    nativeScroll(options)
  );
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(innerScrolls(), 0);
  assert.equal(hostScrolls(), 1);
  assert.equal(await frame.locator('[autocomplete="billing country"]').inputValue(), 'US');
});

test('nested iframe hosts scroll outside-in and share the existing 500ms scroll budget', async (t) => {
  const page = await pageFor(
    t,
    '<div style="height:1210px"></div>' + iframe(iframe(countryHtml + addressHtml))
  );
  const frames = page.frames().slice(1);
  const order = [],
    budgets = [];
  for (const [index, frame] of frames.entries())
    interceptFrameScroll(t, frame, async (_owner, nativeScroll, options) => {
      order.push(index);
      budgets.push(options.timeout);
      if (index === 0) await new Promise((resolve) => setTimeout(resolve, 30));
      return nativeScroll(options);
    });
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(order, [0, 1]);
  assert.ok(budgets[0] <= 500 && budgets[1] < budgets[0]);
});

test('a settled host scroll timeout re-locates once and never selects an offscreen country', async (t) => {
  const page = await pageFor(
    t,
    '<div style="height:1210px"></div>' + iframe(countryHtml + addressHtml)
  );
  const frame = page.frames()[1];
  const scrolls = interceptFrameScroll(t, frame, async () => {
    throw Object.assign(new Error('Synthetic host scroll timeout'), { name: 'TimeoutError' });
  });
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_BLOCKED');
  assert.equal(scrolls(), 1);
  assert.equal(result.inspection.interactionChecks[0].scroll.errorClass, 'scroll_timeout');
  assert.equal(result.inspection.interactionChecks[0].recovery, 'blocked');
  assert.equal(await frame.locator('[autocomplete="billing country"]').inputValue(), 'PH');
});

test('a host scrolled into a persistent main-frame overlay remains blocked without selecting', async (t) => {
  const page = await pageFor(
    t,
    '<div style="height:1210px"></div>' +
      iframe(countryHtml + addressHtml) +
      '<div style="position:fixed;inset:0;z-index:999"></div>'
  );
  const frame = page.frames()[1];
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_BLOCKED');
  assert.equal(result.inspection.interactionChecks[0].afterScrollReason, 'occluded');
  assert.equal(await frame.locator('[autocomplete="billing country"]').inputValue(), 'PH');
});

for (const replacement of [false, true])
  test(`billing re-locates once after settled scroll failure, replacement=${replacement}`, async (t) => {
    const page = await pageFor(
      t,
      countryHtml + addressHtml + '<div id="cover" style="position:fixed;inset:0"></div>'
    );
    const count = interceptCountryScroll(t, page, async (handle) => {
      await page.locator('#cover').evaluate((node) => node.remove());
      if (replacement) await handle.evaluate((node) => node.replaceWith(node.cloneNode(true)));
      const error = new Error(
        replacement ? 'Element is not attached SYNTHETIC_PRIVATE' : 'SYNTHETIC_PRIVATE'
      );
      error.name = replacement ? 'Error' : 'TimeoutError';
      throw error;
    });
    const result = await fillBilling(page, address, 'Synthetic Name', {
      deadline: Date.now() + 4000
    });
    assert.equal(result.ok, true);
    assert.equal(count(), 1, 'recovery must not perform a second scroll');
    assert.equal(await page.locator('[autocomplete="billing country"]').inputValue(), 'US');
    assert.equal(
      await page.locator('[autocomplete="billing name"]').inputValue(),
      'Synthetic Name'
    );
  });

for (const [name, message, expectedClass] of [
  ['TimeoutError', 'SYNTHETIC_PRIVATE', 'scroll_timeout'],
  ['Error', 'Element is not attached SYNTHETIC_PRIVATE', 'node_detached'],
  ['Error', 'Frame was detached SYNTHETIC_PRIVATE', 'frame_changed'],
  ['Error', 'Execution context was destroyed SYNTHETIC_PRIVATE', 'context_destroyed'],
  ['Error', 'SYNTHETIC_PRIVATE', 'other']
])
  test(`persistent country obstruction preserves ${expectedClass} and blocks without a second scroll`, async (t) => {
    const page = await pageFor(
      t,
      countryHtml + addressHtml + '<div id="cover" style="position:fixed;inset:0"></div>'
    );
    const count = interceptCountryScroll(t, page, async () => {
      throw Object.assign(new Error(message), { name });
    });
    const result = await fillBilling(page, address, 'Synthetic Name', {
      deadline: Date.now() + 4000
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'CHECKOUT_CONTROL_BLOCKED');
    assert.deepEqual(result.missing, ['country']);
    assert.equal(count(), 1);
    const [first, second] = result.inspection.interactionChecks;
    assert.equal(first.field, 'country');
    assert.equal(first.tag, 'select');
    assert.equal(first.frameKind, 'main');
    assert.equal(first.initialReason, 'occluded');
    assert.equal(first.pointChecks[0].scope, 'control');
    assert.equal(first.pointChecks[0].reason, 'occluded');
    assert.equal(Number.isInteger(first.pointChecks[0].geometry.viewportHeight), true);
    assert.deepEqual(first.blocker, { tag: 'div', role: 'other', containsTarget: false });
    assert.equal(first.scroll.errorClass, expectedClass);
    assert.ok(first.scroll.durationMs >= 0);
    assert.equal(first.recovery, 'blocked');
    assert.equal(second.initialReason, 'occluded');
    assert.equal(result.inspection.timedOut, false);
    assert.equal(await page.locator('[autocomplete="billing country"]').inputValue(), 'PH');
    assert.equal(await page.locator('[autocomplete="billing name"]').inputValue(), '');
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
  });

test('country scroll recovery rejects newly ambiguous candidates before selecting', async (t) => {
  const page = await pageFor(
    t,
    countryHtml + addressHtml + '<div id="cover" style="position:fixed;inset:0"></div>'
  );
  const count = interceptCountryScroll(t, page, async (handle) => {
    await page.locator('#cover').evaluate((node) => node.remove());
    await handle.evaluate((node) => node.after(node.cloneNode(true)));
    throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { name: 'TimeoutError' });
  });
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.equal(count(), 1);
  assert.deepEqual(
    await page
      .locator('[autocomplete="billing country"]')
      .evaluateAll((nodes) => nodes.map((n) => n.value)),
    ['PH', 'PH']
  );
});

test('incomplete country recovery does not restart the interaction through pure-read retries', async (t) => {
  const page = await pageFor(
    t,
    countryHtml + addressHtml + '<div id="cover" style="position:fixed;inset:0"></div>'
  );
  let recovering = false,
    snapshots = 0;
  const count = interceptCountryScroll(t, page, async () => {
    recovering = true;
    throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { name: 'TimeoutError' });
  });
  const frame = page.mainFrame(),
    locator = frame.locator;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector === 'input,select,textarea,[role="combobox"]') {
      const evaluateAll = result.evaluateAll.bind(result);
      result.evaluateAll = async (...args) => {
        snapshots++;
        if (recovering) throw new Error('Frame was detached SYNTHETIC_PRIVATE');
        return evaluateAll(...args);
      };
    }
    return result;
  };
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(count(), 1);
  assert.equal(snapshots, 2);
  assert.equal(result.inspection.complete, false);
  assert.equal(result.inspection.interactionChecks[0].recovery, 'read_incomplete');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
});

test('country scroll failure after cancellation stops before recovery', async (t) => {
  const page = await pageFor(
    t,
    countryHtml + addressHtml + '<div id="cover" style="position:fixed;inset:0"></div>'
  );
  const controller = new AbortController();
  const count = interceptCountryScroll(t, page, async () => {
    controller.abort();
    throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { name: 'TimeoutError' });
  });
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000,
    signal: controller.signal
  });
  assert.equal(result.errorCode, 'CHECKOUT_FORM_ABORTED');
  assert.equal(count(), 1);
  assert.equal(result.inspection.interactionChecks[0].recovery, undefined);
  assert.equal(await page.locator('[autocomplete="billing country"]').inputValue(), 'PH');
});

function failFrameRead(t, frame, read) {
  const locator = frame.locator;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector === 'input,select,textarea,[role="combobox"]') result.evaluateAll = read;
    return result;
  };
  t.after(() => {
    frame.locator = locator;
  });
}
for (const [message, reason] of [
  ['Frame was detached SYNTHETIC_PRIVATE', 'detached'],
  ['Execution context was destroyed SYNTHETIC_PRIVATE', 'context_destroyed'],
  ['SYNTHETIC_PRIVATE', 'read_failed']
])
  test(`readiness keeps control snapshot ${reason} separate from zero candidates`, async (t) => {
    const page = await pageFor(t, '<main>Payment container</main>');
    failFrameRead(t, page.mainFrame(), async () => {
      throw new Error(message);
    });
    const result = await inspectCardReadiness(page, { deadline: Date.now() + 4000 });
    assert.equal(result.ready, false);
    assert.equal(result.inspection.complete, false);
    assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
    assert.deepEqual(result.inspection.readFailures, [
      {
        phase: 'control_snapshot',
        reason,
        count: 1,
        probe: 'control_scan',
        readOperation: 'control_snapshot',
        frameKind: 'main',
        frameId: 1
      }
    ]);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
  });
test('per-frame snapshot timeout is incomplete while the original global budget remains', async (t) => {
  const page = await pageFor(t, '<main>Payment container</main>');
  failFrameRead(t, page.mainFrame(), () => new Promise(() => {}));
  const result = await inspectCardReadiness(page, { deadline: Date.now() + 4000 });
  assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(result.inspection.timedOut, false);
  assert.equal(result.inspection.complete, false);
  assert.deepEqual(result.inspection.readFailures, [
    {
      phase: 'control_snapshot',
      reason: 'timeout',
      count: 1,
      probe: 'control_scan',
      readOperation: 'control_snapshot',
      frameKind: 'main',
      frameId: 1
    }
  ]);
});
function interceptLoadFailureCount(t, frame, read) {
  const getByText = frame.getByText;
  frame.getByText = function (text, ...options) {
    const result = getByText.call(this, text, ...options);
    if (text === 'Content failed to load') {
      const count = result.count.bind(result);
      result.count = (...args) => read(() => count(...args));
    }
    return result;
  };
  t.after(() => {
    frame.getByText = getByText;
  });
}
function delayOneNumberRead(t, page, phase, change) {
  const frame = page.mainFrame(),
    locator = frame.locator;
  let delayed = false;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector.includes('[autocomplete="cc-number"]')) {
      const handles = result.elementHandles.bind(result);
      result.elementHandles = async () => {
        const list = await handles();
        for (const handle of list) {
          const evaluate = handle.evaluate.bind(handle);
          handle.evaluate = async (fn, arg) => {
            const matchesPhase =
              phase === 'candidate_eligibility'
                ? arg?.control === true
                : String(fn).includes('value:');
            if (!delayed && matchesPhase) {
              delayed = true;
              await change?.();
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return evaluate(fn, arg);
          };
        }
        return list;
      };
    }
    return result;
  };
  t.after(() => {
    frame.locator = locator;
  });
}

test('readiness rejects an empty page, amount text and ordinary iframe inputs', async (t) => {
  for (const html of [
    '',
    '<p>Due today PHP 8919.64</p>',
    iframe('<input placeholder="Ordinary input">')
  ]) {
    const page = await pageFor(t, html);
    const result = await inspectCardReadiness(page, { deadline: Date.now() + 1500 });
    assert.equal(result.ready, false);
    assert.equal(result.code, 'CHECKOUT_CARD_NOT_READY');
    assert.deepEqual(result.missing, ['number']);
    assert.equal(result.inspection.complete, true);
  }
});
test('visible card controls can override an ancestor visibility without admitting hidden copies', async (t) => {
  const page = await pageFor(
    t,
    `<section style="visibility:hidden"><div data-active style="visibility:visible">${cardHtml}</div><input autocomplete="cc-number"></section>`
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.equal(
    await page.locator('[data-active] input[autocomplete="cc-number"]').inputValue(),
    card.number
  );
  assert.equal(await page.locator('section > input').inputValue(), '');
});
test('visible iframe can override ancestor visibility and retain shared fill eligibility', async (t) => {
  const page = await pageFor(
    t,
    `<section style="visibility:hidden">${iframe(cardHtml).replace('width:900px;', 'visibility:visible;width:900px;')}</section>`
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 4000 })).ok, true);
  assert.equal(
    await page.frameLocator('iframe').locator('[autocomplete="cc-number"]').inputValue(),
    card.number
  );
});
for (const [kind, html] of [
  ['ancestor', `<section hidden style="display:block">${cardHtml}</section>`],
  ['contents ancestor', `<section hidden style="display:contents">${cardHtml}</section>`],
  ['own attribute', cardHtml.replaceAll('<input ', '<input hidden style="display:inline-block" ')],
  ['embedded controls', iframe(`<section hidden style="display:block">${cardHtml}</section>`)],
  [
    'nested frame owner',
    `<section hidden style="display:block">${iframe(iframe(cardHtml))}</section>`
  ]
]) {
  test(`rendered hidden attribute on ${kind} uses actual card interaction and readback`, async (t) => {
    const page = await pageFor(t, html);
    const readiness = await inspectCardReadiness(page);
    assert.equal(readiness.ready, true);
    const probe = await inspectCardExclusions(page);
    assert.equal(probe.complete, true);
    assert.deepEqual(probe.numberComparison, { semanticEligible: 1, geometryEditable: 1 });
    const result = await fillCard(page, card, { deadline: Date.now() + 4000 });
    assert.equal(result.ok, true);
    const frame = page.frames().at(-1);
    for (const [ac, value] of [
      ['cc-number', card.number],
      ['cc-exp', card.expiry],
      ['cc-csc', card.cvc]
    ])
      assert.equal(await frame.locator(`[autocomplete="${ac}"]`).inputValue(), value);
  });
}
test('rendered hidden shadow host keeps visible fields and excludes truly hidden duplicates', async (t) => {
  const page = await pageFor(t, '<div id="payment-root" hidden style="display:block"></div>');
  await page.locator('#payment-root').evaluate((host, html) => {
    host.attachShadow({ mode: 'open' }).innerHTML =
      `<section hidden>${html}</section><section data-active>${html}</section>`;
  }, cardHtml);
  assert.equal((await inspectCardReadiness(page)).ready, true);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 4000 })).ok, true);
  assert.equal(
    await page.locator('[data-active] [autocomplete="cc-number"]').inputValue(),
    card.number
  );
  assert.deepEqual(
    await page.locator('section[hidden] input').evaluateAll((nodes) => nodes.map((n) => n.value)),
    ['', '', '', '']
  );
});
test('two rendered hidden card groups stay ambiguous and neither receives card data', async (t) => {
  const page = await pageFor(
    t,
    `<section hidden style="display:block">${cardHtml}</section>` + cardHtml
  );
  const result = await fillCard(page, card, { deadline: Date.now() + 1500 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.ok(
    (await page.locator('input').evaluateAll((nodes) => nodes.map((n) => n.value))).every(
      (v) => v === ''
    )
  );
});
test('rendered hidden billing controls use the same fill and readback eligibility', async (t) => {
  const page = await pageFor(
    t,
    iframe(`<section hidden style="display:block">${countryHtml + addressHtml}</section>`)
  );
  const result = await fillBilling(page, address, 'Synthetic Name', {
    deadline: Date.now() + 4000
  });
  assert.equal(result.ok, true);
  assert.equal(
    await page.frameLocator('iframe').locator('[autocomplete="billing name"]').inputValue(),
    'Synthetic Name'
  );
  assert.equal(
    await page
      .frameLocator('iframe')
      .locator('[autocomplete="billing address-line1"]')
      .inputValue(),
    address.line1
  );
});
test('rendered hidden attributes do not admit inert disabled readonly transparent or occluded fields', async (t) => {
  const cases = [
    ['inert', `<section hidden inert style="display:block">${cardHtml}</section>`],
    [
      'disabled',
      `<section hidden style="display:block">${cardHtml.replaceAll('<input ', '<input disabled ')}</section>`
    ],
    [
      'readonly',
      `<section hidden style="display:block">${cardHtml.replaceAll('<input ', '<input readonly ')}</section>`
    ],
    ['opacity_zero', `<section hidden style="display:block;opacity:0">${cardHtml}</section>`],
    [
      'content_visibility_hidden',
      `<section hidden style="display:block;content-visibility:hidden">${cardHtml}</section>`
    ],
    [
      'occluded',
      `<section hidden style="display:block">${cardHtml}</section><div style="position:fixed;inset:0;background:white"></div>`
    ]
  ];
  for (const [reason, html] of cases) {
    const page = await pageFor(t, html);
    const readiness = await inspectCardReadiness(page);
    assert.equal(readiness.ready, false, reason);
    if (reason === 'occluded') assert.ok(readiness.inspection.interactionRejectCounts.occluded > 0);
    else assert.ok(readiness.inspection.controlRejectCounts[reason] > 0, reason);
    assert.ok(
      (await page.locator('input').evaluateAll((nodes) => nodes.map((n) => n.value))).every(
        (v) => v === ''
      ),
      reason
    );
  }
});
test('visibility override does not relax other card control or iframe exclusions', async (t) => {
  const cases = [
    ['hidden', '<section hidden>'],
    ['inert', '<section inert>'],
    ['display_none', '<section style="display:none">'],
    ['opacity_zero', '<section style="opacity:0">'],
    ['content_visibility_hidden', '<section style="content-visibility:hidden">']
  ];
  for (const [reason, start] of cases) {
    const page = await pageFor(
      t,
      start + '<input autocomplete="cc-number" style="visibility:visible"></section>'
    );
    const result = await inspectCardReadiness(page);
    assert.equal(result.ready, false, reason);
    assert.ok(result.inspection.controlRejectCounts[reason] > 0, reason);
    const framed = await pageFor(
      t,
      start +
        iframe(cardHtml).replace('width:900px;', 'visibility:visible;width:900px;') +
        '</section>'
    );
    const frameResult = await inspectCardReadiness(framed);
    assert.equal(frameResult.ready, false, reason);
    assert.ok(frameResult.inspection.frameSkipCounts[reason] > 0, reason);
  }
});
test('shadow root labels use the control tree and do not bind document or sibling tree labels', async (t) => {
  const page = await pageFor(
    t,
    '<span id="field-label">Order number</span><div id="payment-root"></div><div id="contact-root"></div>'
  );
  await page.evaluate(() => {
    document.getElementById('payment-root').attachShadow({ mode: 'open' }).innerHTML =
      '<span id="field-label">Card number</span><input aria-labelledby="field-label"><input autocomplete="cc-exp"><input autocomplete="cc-csc">';
    document.getElementById('contact-root').attachShadow({ mode: 'open' }).innerHTML =
      '<span id="field-label">City</span><input aria-labelledby="field-label">';
  });
  assert.equal((await inspectCardReadiness(page)).ready, true);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.equal(
    await page.locator('#payment-root').getByLabel('Card number', { exact: true }).inputValue(),
    card.number
  );
  assert.equal(
    await page.locator('#contact-root').getByLabel('City', { exact: true }).inputValue(),
    ''
  );
});
test('shadow root label references cannot fall through to labels in another tree', async (t) => {
  const page = await pageFor(
    t,
    '<span id="field-label">Card number</span><div id="payment-root"></div>'
  );
  await page.evaluate(() => {
    document.getElementById('payment-root').attachShadow({ mode: 'open' }).innerHTML =
      '<input aria-labelledby="field-label">';
  });
  const result = await inspectCardReadiness(page);
  assert.equal(result.ready, false);
  assert.equal(result.inspection.controlCounts.recognized, 0);
  assert.equal(await page.locator('#payment-root input').inputValue(), '');
});
test('two visible shadow card labels remain ambiguous and neither is filled', async (t) => {
  const page = await pageFor(t, '<div id="first-root"></div><div id="second-root"></div>');
  await page.evaluate(() => {
    for (const id of ['first-root', 'second-root'])
      document.getElementById(id).attachShadow({ mode: 'open' }).innerHTML =
        '<span id="field-label">Card number</span><input aria-labelledby="field-label">';
  });
  const result = await fillCard(page, card, { deadline: Date.now() + 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.deepEqual(await page.locator('input').evaluateAll((nodes) => nodes.map((n) => n.value)), [
    '',
    ''
  ]);
});
test('control diagnostics distinguish scan eligibility locator and recognition without field data', async (t) => {
  const page = await pageFor(
    t,
    '<input autocomplete="cc-number"><input id="unrelated" value="PRIVATE_VALUE">' +
      '<input><input readonly autocomplete="cc-number"><input disabled autocomplete="cc-number">' +
      '<input aria-disabled="true" autocomplete="cc-number"><input type="checkbox">' +
      '<input style="visibility:hidden" autocomplete="cc-number">'
  );
  const result = await inspectCardReadiness(page);
  assert.equal(result.ready, true);
  assert.deepEqual(result.inspection.controlCounts, {
    scanned: 8,
    eligible: 3,
    locatable: 2,
    recognized: 1
  });
  assert.deepEqual(result.inspection.controlRejectCounts, {
    readonly: 1,
    disabled: 1,
    aria_disabled: 1,
    excluded_type: 1,
    visibility_hidden: 1,
    no_locator: 1
  });
  for (const counts of [
    result.inspection.frameSkipCounts,
    result.inspection.controlCounts,
    result.inspection.controlRejectCounts
  ])
    assert.ok(Object.values(counts).every((n) => Number.isSafeInteger(n) && n >= 0));
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_VALUE|unrelated|autocomplete|aria-labelledby|field-label/
  );
});
test('frame diagnostics count hidden visibility and zero geometry without identifying frames', async (t) => {
  const page = await pageFor(
    t,
    cardHtml +
      iframe('<input autocomplete="cc-number">').replace(
        'width:900px;height:600px',
        'visibility:hidden;width:900px;height:600px'
      ) +
      iframe('<input autocomplete="cc-number">').replace(
        'width:900px;height:600px',
        'width:0;height:0;border:0'
      )
  );
  const result = await inspectCardReadiness(page, { deadline: Date.now() + 3000 });
  assert.equal(result.ready, true);
  assert.equal(result.inspection.framesSkipped, 2);
  assert.deepEqual(result.inspection.frameSkipCounts, { visibility_hidden: 1, zero_geometry: 1 });
  assert.doesNotMatch(JSON.stringify(result.inspection), /srcdoc|iframe|cc-number|http|number/);
});
test('transparent editable card input is diagnosed without changing strict readiness or its value', async (t) => {
  const page = await pageFor(
    t,
    '<label>Card number<input autocomplete="cc-number" style="opacity:0"></label>'
  );
  const input = page.locator('input');
  assert.equal(await input.isVisible(), true);
  assert.equal(await input.isEditable(), true);
  await input.fill('4242424242424242');
  assert.equal((await inspectCardReadiness(page)).ready, false);
  const result = await inspectCardExclusions(page);
  assert.equal(result.complete, true);
  assert.equal(result.shadowCoverage, 'open_only');
  assert.deepEqual(result.numberComparison, { semanticEligible: 0, geometryEditable: 1 });
  assert.deepEqual(result.rows, [
    {
      field: 'number',
      source: 'control',
      reason: 'opacity_zero',
      at: 'self',
      frameKind: 'main',
      boxVisible: true,
      editable: true,
      count: 1
    }
  ]);
  assert.equal(await input.inputValue(), '4242424242424242');
  assert.doesNotMatch(
    JSON.stringify(result),
    /4242424242424242|autocomplete|cc-number|Card number/
  );
});

test('excluded frame diagnostics identify semantic fields through nested and shadow controls', async (t) => {
  const page = await pageFor(
    t,
    '<section style="opacity:0">' + iframe(iframe('<div id="root"></div>')) + '</section>'
  );
  const frame = page.frames()[2];
  await frame.locator('#root').evaluate((n) => {
    n.attachShadow({ mode: 'open' }).innerHTML =
      '<input autocomplete="cc-number"><input autocomplete="cc-csc">';
  });
  const result = await inspectCardExclusions(page);
  assert.equal(result.complete, true);
  assert.equal(result.framesInspected, 3);
  assert.deepEqual(result.numberComparison, { semanticEligible: 0, geometryEditable: 1 });
  assert.deepEqual(
    result.rows.map((row) => [row.field, row.source, row.reason, row.at, row.frameKind]),
    [
      ['number', 'frame', 'opacity_zero', 'ancestor', 'embedded'],
      ['cvc', 'frame', 'opacity_zero', 'ancestor', 'embedded']
    ]
  );
  assert.equal((await inspectCardReadiness(page)).ready, false);
  assert.deepEqual(await frame.locator('input').evaluateAll((nodes) => nodes.map((n) => n.value)), [
    '',
    ''
  ]);
});

test('exclusion probe distinguishes absent fields from self and ancestor hidden fields', async (t) => {
  const page = await pageFor(t, '<input name="ordinary" value="PRIVATE_FIELD_VALUE">');
  const empty = await inspectCardExclusions(page);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.numberComparison, { semanticEligible: 0, geometryEditable: 0 });
  await page.setContent(
    '<input hidden autocomplete="cc-number"><section hidden><input autocomplete="cc-csc"></section>'
  );
  const hidden = await inspectCardExclusions(page);
  assert.deepEqual(
    hidden.rows.map((row) => [row.field, row.reason, row.at, row.boxVisible]),
    [
      ['number', 'hidden', 'self', false],
      ['cvc', 'hidden', 'ancestor', false]
    ]
  );
  assert.doesNotMatch(JSON.stringify([empty, hidden]), /PRIVATE|ordinary|cc-number|cc-csc/);
});

test('exclusion probe is bounded on frame failure and never changes the original readiness', async (t) => {
  const page = await pageFor(t, cardHtml);
  const before = await inspectCardReadiness(page);
  failFrameRead(t, page.mainFrame(), () => new Promise(() => {}));
  const started = Date.now();
  const result = await inspectCardExclusions(page, { deadline: started + 100 });
  assert.equal(result.complete, false);
  assert.equal(result.framesFailed, 1);
  assert.deepEqual(result.failures, [{ phase: 'control_snapshot', reason: 'timeout', count: 1 }]);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 700);
  assert.equal(before.ready, true);

  // A timer may fire before Date.now() advances to its deadline. Preserve the
  // global timeout cause, but distinguish a shorter per-frame read budget.
  const source = readFileSync(require.resolve('../checkout-form.cjs'), 'utf8');
  for (const budget of [80, 1000]) {
    let clock = 1000;
    const deadline = clock + budget;
    let laterReads = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      Date: { now: () => clock },
      setTimeout: (callback, delay) =>
        setTimeout(() => {
          clock += delay - 1;
          callback();
        }, delay),
      clearTimeout
    });
    const frame = (read) => ({
      parentFrame: () => null,
      locator: () => ({ evaluateAll: read })
    });
    const hung = frame(() => new Promise(() => {}));
    const later = frame(async () => {
      laterReads++;
      return { metas: [], rejectedMetas: [] };
    });
    const probe = await module.exports.inspectCardExclusions(
      { isClosed: () => false, frames: () => [hung, later] },
      { deadline }
    );
    assert.equal(probe.complete, false);
    assert.equal(probe.framesFailed, 1);
    assert.equal(probe.failures[0].phase, 'control_snapshot');
    assert.equal(probe.failures[0].reason, 'timeout');
    assert.equal(probe.timedOut, budget === 80);
    assert.equal(laterReads, budget === 80 ? 0 : 1);
  }
});

test('exclusion probe identifies replaced frames without keeping exception text', async (t) => {
  const page = await pageFor(t, cardHtml);
  failFrameRead(t, page.mainFrame(), async () => {
    throw Error('Execution context was destroyed: PRIVATE_FRAME_DETAILS');
  });
  const result = await inspectCardExclusions(page);
  assert.equal(result.complete, false);
  assert.deepEqual(result.failures, [{ phase: 'control_snapshot', reason: 'detached', count: 1 }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FRAME_DETAILS|Execution context/);
});

test('exclusion probe does not mistake a card-labelled checkbox for an editable input', async (t) => {
  const page = await pageFor(t, '<input type="checkbox" autocomplete="cc-number">');
  const result = await inspectCardExclusions(page);
  assert.equal(result.complete, true);
  assert.deepEqual(result.numberComparison, { semanticEligible: 0, geometryEditable: 0 });
  assert.equal(result.rows[0].reason, 'excluded_type');
  assert.equal(result.rows[0].editable, false);
});

test('exclusion probe honours cancellation and closed pages without permitting a new action', async (t) => {
  const page = await pageFor(t, cardHtml);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await inspectCardExclusions(page, { signal: controller.signal });
  assert.equal(cancelled.complete, false);
  assert.equal(cancelled.aborted, true);
  assert.equal(cancelled.framesInspected, 0);
  await page.close();
  const ended = await inspectCardExclusions(page);
  assert.equal(ended.complete, false);
  assert.equal(ended.pageClosed, true);
});
test('diagnostic counters preserve the existing deadline when the renderer read cannot finish', async (t) => {
  const page = await pageFor(t, cardHtml);
  failFrameRead(t, page.mainFrame(), () => new Promise(() => {}));
  const started = Date.now();
  const result = await inspectCardReadiness(page, { deadline: started + 100 });
  assert.equal(result.ready, false);
  assert.equal(result.code, 'CHECKOUT_FORM_TIMEOUT');
  assert.equal(result.inspection.complete, false);
  assert.equal(result.inspection.timedOut, true);
  assert.deepEqual(result.inspection.controlCounts, {
    scanned: 0,
    eligible: 0,
    locatable: 0,
    recognized: 0
  });
  assert.deepEqual(result.inspection.controlRejectCounts, {});
  assert.ok(Date.now() - started < 1000);
});
const legacyCardAliases = [
  ['number', 'autocomplete', '<input autocomplete="cc-number">'],
  ['number', 'cardnumber name', '<input name="cardnumber">'],
  ['number', 'number name', '<input name="number">'],
  ['number', 'numeric placeholder', '<input placeholder="1234 1234 1234 1234">'],
  ['number', 'stable field', '<input data-elements-stable-field-name="cardNumber">'],
  ['number', 'accessible label', '<input aria-label="Card number">'],
  ['expiry', 'autocomplete', '<input autocomplete="cc-exp">'],
  ['expiry', 'exp-date name', '<input name="exp-date">'],
  ['expiry', 'MM placeholder', '<input placeholder="MM / YY">'],
  ['expiry', 'stable field', '<input data-elements-stable-field-name="cardExpiry">'],
  ['cvc', 'autocomplete', '<input autocomplete="cc-csc">'],
  ['cvc', 'cardCvc name', '<input name="cardCvc">'],
  ['cvc', 'stable field', '<input data-elements-stable-field-name="cardCvc">']
];
for (const [field, alias, html] of legacyCardAliases) {
  test(`legacy card alias ${field}: ${alias} shares readiness, fill and readback`, async (t) => {
    const fields = {
      number: '<input autocomplete="cc-number">',
      expiry: '<input autocomplete="cc-exp">',
      cvc: '<input autocomplete="cc-csc">',
      [field]: html
    };
    const page = await pageFor(t, Object.values(fields).join(''));
    assert.equal((await inspectCardReadiness(page)).ready, true);
    const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ code: result.errorCode, missing: result.missing })
    );
    assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), [
      card.number,
      card.expiry,
      card.cvc
    ]);
  });
}
test('legacy number aliases retain number-first readiness without companion fields', async (t) => {
  for (const html of [
    '<input name="number">',
    '<input placeholder="1234 1234 1234 1234">',
    '<input data-elements-stable-field-name="cardNumber">'
  ]) {
    const page = await pageFor(t, '<h2>Configure your plan</h2>' + html);
    assert.equal((await inspectCardReadiness(page)).ready, true);
    assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), ['']);
  }
});
test('legacy weak number aliases reject explicit non-card controls without writing', async (t) => {
  for (const html of [
    '<input name="number" type="number">',
    '<input name="number" aria-label="Order number">',
    '<input name="number" aria-label="Quantity">',
    '<input placeholder="Order number 1234">',
    '<input placeholder="1234" aria-label="Postal code">',
    '<input name="phoneNumber" placeholder="1234">'
  ]) {
    const page = await pageFor(t, '<h2>Configure your plan</h2>' + html);
    const result = await inspectCardReadiness(page);
    assert.equal(result.ready, false);
    assert.equal(result.code, 'CHECKOUT_CARD_NOT_READY');
    assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), ['']);
  }
});
test('strong card semantics are not excluded by weak-alias non-card words', async (t) => {
  for (const html of [
    '<input autocomplete="cc-number" aria-label="Order reference">',
    '<input data-elements-stable-field-name="cardNumber" aria-label="Order reference">'
  ]) {
    const page = await pageFor(t, html);
    assert.equal((await inspectCardReadiness(page)).ready, true);
  }
});
test('legacy aliases support separate nested frames and ignore hidden duplicates', async (t) => {
  const page = await pageFor(
    t,
    `<section hidden>${iframe('<input name="number">')}</section>` +
      iframe(iframe('<input data-elements-stable-field-name="cardNumber">')) +
      iframe('<input placeholder="MM / YY">') +
      '<input name="cardCvc">'
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  const result = await fillCard(page, card, { deadline: Date.now() + 5000 });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.frameLocator('iframe').nth(0).locator('input').inputValue(), '');
  assert.equal(
    await page.frameLocator('iframe').nth(1).frameLocator('iframe').locator('input').inputValue(),
    card.number
  );
  assert.equal(await page.frameLocator('iframe').nth(2).locator('input').inputValue(), card.expiry);
  assert.equal(await page.locator('input').inputValue(), card.cvc);
});
test('stable card fields outrank shared autocomplete off without merging controls', async (t) => {
  const stableFields =
    '<input data-elements-stable-field-name="cardNumber" autocomplete="off">' +
    '<input data-elements-stable-field-name="cardExpiry" autocomplete="off">' +
    '<input data-elements-stable-field-name="cardCvc" autocomplete="off">';
  const page = await pageFor(
    t,
    `<section hidden>${stableFields}</section><section data-active>${stableFields}</section>`
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.deepEqual(
    await page.locator('[data-active] input').evaluateAll((ns) => ns.map((n) => n.value)),
    [card.number, card.expiry, card.cvc]
  );
  assert.deepEqual(
    await page.locator('[hidden] input').evaluateAll((ns) => ns.map((n) => n.value)),
    ['', '', '']
  );
});
for (const [kind, fields] of [
  ['names', '<input name="number"><input name="exp-date"><input name="cardCvc">'],
  [
    'placeholders',
    '<input placeholder="1234 1234 1234 1234"><input placeholder="MM / YY"><input placeholder="CVC">'
  ]
]) {
  test(`legacy ${kind} remain distinct with shared non-semantic autocomplete`, async (t) => {
    for (const autocomplete of ['off', 'on']) {
      const html = fields.replaceAll('<input ', `<input autocomplete="${autocomplete}" `);
      const page = await pageFor(t, html);
      assert.equal((await inspectCardReadiness(page)).ready, true);
      const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
      assert.equal(
        result.ok,
        true,
        JSON.stringify({ code: result.errorCode, missing: result.missing })
      );
      assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), [
        card.number,
        card.expiry,
        card.cvc
      ]);
    }
  });
}
test('visible stable card-number duplicates with shared autocomplete off remain ambiguous', async (t) => {
  const page = await pageFor(
    t,
    '<input data-elements-stable-field-name="cardNumber" autocomplete="off">' +
      '<input data-elements-stable-field-name="cardNumber" autocomplete="off">' +
      '<input data-elements-stable-field-name="cardExpiry" autocomplete="off">' +
      '<input data-elements-stable-field-name="cardCvc" autocomplete="off">'
  );
  assert.equal((await inspectCardReadiness(page)).code, 'CHECKOUT_CONTROL_AMBIGUOUS');
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), [
    '',
    '',
    '',
    ''
  ]);
});
test('legacy number aliases cannot compete with another visible card candidate', async (t) => {
  for (const other of ['<input autocomplete="cc-number">', '<input placeholder="1234">']) {
    const page = await pageFor(
      t,
      '<input name="number">' + other + '<input name="exp-date"><input name="cardCvc">'
    );
    assert.equal((await inspectCardReadiness(page)).code, 'CHECKOUT_CONTROL_AMBIGUOUS');
    const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
    assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
    assert.deepEqual(await page.locator('input').evaluateAll((ns) => ns.map((n) => n.value)), [
      '',
      '',
      '',
      ''
    ]);
  }
});
test('legacy weak placeholders cannot override another strong card-field meaning', async (t) => {
  const page = await pageFor(
    t,
    '<input name="number"><input name="exp-date"><input aria-label="Security code" placeholder="1234">'
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.getByLabel('Security code').inputValue(), card.cvc);
});
const legacyBillingAliases = [
  ['line1', 'line1 name', '<input name="line1">'],
  ['city', 'billingLocality id', '<input id="billingLocality">'],
  ['city', 'billingLocality name', '<input name="billingLocality">'],
  ['city', 'billingAddressCity name', '<input name="billingAddressCity">'],
  ['state', 'billingAddressState name', '<input name="billingAddressState">'],
  [
    'country',
    'billingCountry id',
    '<select id="billingCountry"><option value="PH">Philippines</option><option value="US">United States</option></select>'
  ],
  [
    'country',
    'billingCountry name',
    '<select name="billingCountry"><option value="PH">Philippines</option><option value="US">United States</option></select>'
  ],
  [
    'country',
    'billingAddressCountry name',
    '<select name="billingAddressCountry"><option value="PH">Philippines</option><option value="US">United States</option></select>'
  ],
  ['name', 'generic id and name', '<input id="opaque" name="name">'],
  ['name', 'Your name placeholder', '<input placeholder="Your name">'],
  ['name', 'Cardholder name placeholder', '<input placeholder="Cardholder name">'],
  ['name', 'Name on card placeholder', '<input placeholder="Name on card">'],
  ['line1', 'Address placeholder', '<input placeholder="Address">'],
  ['line1', 'Enter address placeholder', '<input placeholder="Enter address">'],
  ['postal', 'Postal placeholder', '<input placeholder="Postal">'],
  ['postal', 'Zipcode placeholder', '<input placeholder="Zipcode">'],
  ['postal', 'billingAddressZip name', '<input name="billingAddressZip">'],
  ...[
    ['name', 'billingName'],
    ['line1', 'billingAddressLine1'],
    ['city', 'billingLocality'],
    ['state', 'billingAdministrativeArea'],
    ['postal', 'billingPostalCode'],
    ['country', 'billingCountry']
  ].map(([field, id]) => [
    field,
    `test id ${id}`,
    field === 'country'
      ? `<select data-testid="${id}"><option value="PH">Philippines</option><option value="US">United States</option></select>`
      : `<input data-testid="${id}">`
  ])
];
for (const [field, alias, html] of legacyBillingAliases) {
  test(`legacy billing alias ${field}: ${alias} supports writing and readback`, async (t) => {
    const fields = {
      country: countryHtml,
      line1: '<input autocomplete="billing address-line1">',
      city: '<input autocomplete="billing address-level2">',
      postal: '<input autocomplete="billing postal-code">',
      name: '<input autocomplete="billing name">',
      state: '<input autocomplete="billing address-level1">',
      [field]: html.replace(/<(input|select) /g, '<$1 autocomplete="off" ')
    };
    const page = await pageFor(
      t,
      `<fieldset aria-label="Billing address">${Object.values(fields).join('')}</fieldset>`
    );
    assert.equal(
      (await diagnostic(page)).some((control) => control.fields.includes(field)),
      true
    );
    const result = await fillBilling(page, address, 'Synthetic Person', {
      deadline: Date.now() + 3000
    });
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ code: result.errorCode, missing: result.missing })
    );
    assert.deepEqual(
      await page.locator('input,select').evaluateAll((ns) => ns.map((n) => n.value)),
      ['US', address.line1, address.city, address.postal_code, 'Synthetic Person', address.state]
    );
  });
}
test('collapsed billing controls expand once through their unique interactive entry', async (t) => {
  const page = await pageFor(
    t,
    '<button type="button" aria-expanded="false" aria-controls="billing-fields">Billing address</button>' +
      `<section id="billing-fields" hidden>${countryHtml + addressHtml}</section>`
  );
  await page.locator('button').evaluate((n) =>
    n.addEventListener('click', () => {
      window.syntheticExpands = (window.syntheticExpands || 0) + 1;
      n.setAttribute('aria-expanded', 'true');
      document.getElementById('billing-fields').hidden = false;
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 1500
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.evaluate(() => window.syntheticExpands), 1);
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
  assert.equal(await page.evaluate(() => window.syntheticExpands), 1);
});
test('billing expansion readiness keeps the existing one fresh read after a transient scan delay', async (t) => {
  const page = await pageFor(t, countryHtml + addressHtml);
  const frame = page.mainFrame(),
    locator = frame.locator;
  let delayed = false;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector === 'input,select,textarea,[role="combobox"]') {
      const read = result.evaluateAll.bind(result);
      result.evaluateAll = async (...args) => {
        if (
          !delayed &&
          (await page.locator('select[autocomplete="billing country"]').inputValue()) === 'US'
        ) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        return read(...args);
      };
    }
    return result;
  };
  t.after(() => {
    frame.locator = locator;
  });
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 3000
  });
  assert.equal(delayed, true);
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
});
test('manual billing entry ignores hidden and disabled duplicates and never submits a form', async (t) => {
  const page = await pageFor(
    t,
    countryHtml +
      '<button type="button" hidden>Enter address manually</button>' +
      '<button type="button" disabled>Enter address manually</button>' +
      '<form><button type="submit">Enter address manually</button></form>' +
      '<button type="button" aria-controls="manual-fields">Enter address manually</button>' +
      `<section id="manual-fields" hidden>${addressHtml}</section>`
  );
  await page.locator('button[aria-controls]').evaluate((n) =>
    n.addEventListener('click', () => {
      window.syntheticExpands = (window.syntheticExpands || 0) + 1;
      document.getElementById('manual-fields').hidden = false;
    })
  );
  await page.locator('form').evaluate((n) =>
    n.addEventListener('submit', (e) => {
      e.preventDefault();
      window.syntheticSubmits = (window.syntheticSubmits || 0) + 1;
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 1500
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.evaluate(() => window.syntheticExpands), 1);
  assert.equal(await page.evaluate(() => window.syntheticSubmits || 0), 0);
});
test('multiple real billing expansion entries stop without clicking either', async (t) => {
  const page = await pageFor(
    t,
    '<button type="button">Billing address</button><button type="button">Billing address</button>'
  );
  await page.locator('button').evaluateAll((ns) =>
    ns.forEach((n) =>
      n.addEventListener('click', () => {
        window.syntheticExpands = (window.syntheticExpands || 0) + 1;
      })
    )
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 400
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.equal(await page.evaluate(() => window.syntheticExpands || 0), 0);
});
for (const role of ['role="combobox"', '']) {
  test(`bound billing dropdown supports precise non-role options ${role || 'plain input'}`, async (t) => {
    const page = await pageFor(
      t,
      `<input ${role} aria-label="Country" aria-controls="country-popup" value="PH">` +
        addressHtml +
        '<div id="country-popup" hidden><button type="button" data-value="US">United States</button></div>'
    );
    await page.getByLabel('Country', { exact: true }).evaluate((n) => {
      n.addEventListener('focus', () => {
        document.getElementById('country-popup').hidden = false;
      });
    });
    await page.locator('#country-popup button').evaluate((n) =>
      n.addEventListener('click', () => {
        window.syntheticSelections = (window.syntheticSelections || 0) + 1;
        document.querySelector('input[aria-controls]').value = 'US';
        document.getElementById('country-popup').hidden = true;
      })
    );
    const result = await fillBilling(page, address, 'Synthetic Person', {
      deadline: Date.now() + 2000
    });
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ code: result.errorCode, missing: result.missing })
    );
    assert.equal(await page.evaluate(() => window.syntheticSelections), 1);
  });
}
test('billing dropdown never selects matching text from an unbound popup', async (t) => {
  for (const binding of ['', 'aria-controls="wrong-popup"']) {
    const page = await pageFor(
      t,
      `<input role="combobox" aria-label="Country" ${binding} value="PH">` +
        addressHtml +
        '<div id="wrong-popup"><div role="option">Canada</div></div>' +
        '<div id="other-popup"><div role="option">United States</div></div>'
    );
    await page.locator('#other-popup [role="option"]').evaluate((n) =>
      n.addEventListener('click', () => {
        window.syntheticSelections = (window.syntheticSelections || 0) + 1;
      })
    );
    const result = await fillBilling(page, address, 'Synthetic Person', {
      deadline: Date.now() + 700
    });
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => window.syntheticSelections || 0), 0);
  }
});
test('duplicate exact dropdown choices remain ambiguous without a click', async (t) => {
  const page = await pageFor(
    t,
    '<input role="combobox" aria-label="Country" aria-controls="country-popup" value="PH">' +
      addressHtml +
      '<div id="country-popup"><button type="button">United States</button><button type="button">US</button></div>'
  );
  await page.locator('#country-popup button').evaluateAll((ns) =>
    ns.forEach((n) =>
      n.addEventListener('click', () => {
        window.syntheticSelections = (window.syntheticSelections || 0) + 1;
      })
    )
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 700
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.equal(await page.evaluate(() => window.syntheticSelections || 0), 0);
});
test('billing dropdown options appearing after its original deadline cannot be clicked', async (t) => {
  const page = await pageFor(
    t,
    '<input role="combobox" aria-label="Country" aria-controls="country-popup" value="PH">' +
      addressHtml +
      '<div id="country-popup" hidden><button type="button">United States</button></div>'
  );
  await page.locator('button').evaluate((n) =>
    n.addEventListener('click', () => {
      window.syntheticSelections = (window.syntheticSelections || 0) + 1;
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 200
  });
  assert.equal(result.ok, false);
  await page.locator('#country-popup').evaluate((n) => {
    n.hidden = false;
  });
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => window.syntheticSelections || 0), 0);
});
test('button billing combobox selects from its bound popup and reads the selected text', async (t) => {
  const page = await pageFor(
    t,
    '<button type="button" role="combobox" aria-label="Country" aria-controls="country-popup">PH</button>' +
      '<input readonly aria-label="Country" value="PH"><input hidden role="combobox" aria-label="Country">' +
      addressHtml +
      '<div id="country-popup" hidden><div>United States</div></div>'
  );
  await page.getByRole('combobox', { name: 'Country' }).evaluate((n) =>
    n.addEventListener('click', () => {
      document.getElementById('country-popup').hidden = false;
    })
  );
  await page.locator('#country-popup div').evaluate((n) =>
    n.addEventListener('click', () => {
      window.syntheticSelections = (window.syntheticSelections || 0) + 1;
      document.querySelector('button[role="combobox"]').textContent = 'United States';
      document.getElementById('country-popup').hidden = true;
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 1000
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.evaluate(() => window.syntheticSelections), 1);
});
test('bound dropdown candidates cannot submit a form', async (t) => {
  const page = await pageFor(
    t,
    '<input role="combobox" aria-label="Country" aria-controls="country-popup" value="PH">' +
      addressHtml +
      '<form id="country-popup"><button type="submit">United States</button></form>'
  );
  await page.locator('form').evaluate((n) =>
    n.addEventListener('submit', (e) => {
      e.preventDefault();
      window.syntheticSubmits = (window.syntheticSubmits || 0) + 1;
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 400
  });
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate(() => window.syntheticSubmits || 0), 0);
});
test('delayed bound dropdown choices share the existing deadline and actual selection is verified', async (t) => {
  const page = await pageFor(
    t,
    '<input role="combobox" aria-label="Country" aria-controls="country-popup" value="PH">' +
      addressHtml +
      '<div id="country-popup"></div>'
  );
  await page.getByLabel('Country', { exact: true }).evaluate((n) =>
    n.addEventListener('focus', () => {
      if (window.syntheticOptionScheduled) return;
      window.syntheticOptionScheduled = true;
      window.setTimeout(() => {
        const option = document.createElement('div');
        option.textContent = 'United States';
        option.addEventListener('click', () => {
          window.syntheticSelections = (window.syntheticSelections || 0) + 1;
          n.value = 'US';
        });
        document.getElementById('country-popup').append(option);
      }, 100);
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 2000
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({ code: result.errorCode, missing: result.missing })
  );
  assert.equal(await page.evaluate(() => window.syntheticSelections), 1);
});
test('bound dropdown selection with wrong actual readback cannot complete billing', async (t) => {
  const page = await pageFor(
    t,
    '<button type="button" role="combobox" aria-label="Country" aria-controls="country-popup">PH</button>' +
      addressHtml +
      '<div id="country-popup"><div>United States</div></div>'
  );
  await page.locator('#country-popup div').evaluate((n) =>
    n.addEventListener('click', () => {
      window.syntheticSelections = (window.syntheticSelections || 0) + 1;
      document.querySelector('button[role="combobox"]').textContent = 'Canada';
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 600
  });
  assert.equal(result.ok, false);
  assert.ok((await page.evaluate(() => window.syntheticSelections || 0)) > 0);
});
test('cancelled billing cannot click an expansion entry that appears later', async (t) => {
  const page = await pageFor(t, countryHtml);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  t.after(() => clearTimeout(timer));
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 2000,
    signal: controller.signal
  });
  assert.equal(result.errorCode, 'CHECKOUT_FORM_ABORTED');
  await page.evaluate(() => {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.textContent = 'Billing address';
    entry.addEventListener('click', () => {
      window.syntheticExpands = (window.syntheticExpands || 0) + 1;
    });
    document.body.append(entry);
  });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.syntheticExpands || 0), 0);
});
test('readiness excludes hidden and inert iframe ancestors, including nested frames', async (t) => {
  for (const html of [
    iframe(cardHtml).replace('<iframe', '<iframe hidden'),
    `<section style="display:none">${iframe(iframe(cardHtml))}</section>`,
    `<section inert>${iframe(iframe(cardHtml))}</section>`,
    `<section style="opacity:0">${iframe(cardHtml)}</section>`
  ]) {
    const page = await pageFor(t, html);
    const result = await inspectCardReadiness(page, { deadline: Date.now() + 1500 });
    assert.equal(result.ready, false);
    assert.equal(result.code, 'CHECKOUT_CARD_NOT_READY');
    assert.ok(result.inspection.framesSkipped > 0);
    assert.equal(
      result.controls.some((control) => control.fields.includes('number')),
      false
    );
  }
});
test('hidden iframe duplicates cannot compete with the active card fields', async (t) => {
  const page = await pageFor(t, `<section inert>${iframe(iframe(cardHtml))}</section>` + cardHtml);
  assert.equal((await inspectCardReadiness(page)).ready, true);
  const result = await fillCard(page, card, { deadline: Date.now() + 2500 });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({
      errorCode: result.errorCode,
      missing: result.missing,
      inspection: result.inspection
    })
  );
  assert.equal(await page.frames()[2].locator('[autocomplete="cc-number"]').inputValue(), '');
});
test('opacity and aria-disabled duplicates use the same eligibility for scan, fill and readback', async (t) => {
  for (const inactive of ['style="opacity:0"', 'aria-disabled="true"', 'class="not-visible"']) {
    const page = await pageFor(
      t,
      '<style>.not-visible { opacity:0 }</style>' +
        `<section data-inactive ${inactive}>${cardHtml}</section>` +
        cardHtml
    );
    const ready = await inspectCardReadiness(page);
    assert.equal(ready.ready, true);
    const result = await fillCard(page, card, { deadline: Date.now() + 2500 });
    assert.equal(
      result.ok,
      true,
      JSON.stringify({
        errorCode: result.errorCode,
        missing: result.missing,
        inspection: result.inspection
      })
    );
    assert.deepEqual(
      await page.locator('[data-inactive] input').evaluateAll((ns) => ns.map((n) => n.value)),
      ['', '', '', '']
    );
  }
});
test('readiness permits number-first dynamic expiry and CVC, and fill uses that same field', async (t) => {
  const page = await pageFor(t, '<input aria-label="Card number">');
  await page.locator('input').evaluate((n) =>
    n.addEventListener('input', () => {
      if (!document.querySelector('[autocomplete="cc-exp"]'))
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input autocomplete="cc-exp"><input autocomplete="cc-csc">'
        );
    })
  );
  const ready = await inspectCardReadiness(page);
  assert.equal(ready.ready, true);
  assert.equal(ready.code, 'CHECKOUT_CARD_READY');
  assert.deepEqual(ready.missing, []);
  assert.equal(await page.locator('input').inputValue(), '');
  assert.equal(await page.locator('[autocomplete="cc-exp"]').count(), 0);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 2500 })).ok, true);
});
test('semantic readback rediscovers a number input replaced by its own input handler', async (t) => {
  const page = await pageFor(t, '<input autocomplete="cc-number">');
  await page.locator('input').evaluate((n) =>
    n.addEventListener(
      'input',
      () => {
        const replacement = n.cloneNode();
        replacement.value = n.value;
        n.replaceWith(replacement);
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input autocomplete="cc-exp"><input autocomplete="cc-csc">'
        );
      },
      { once: true }
    )
  );
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 2500 })).ok, true);
  assert.equal(await page.locator('[autocomplete="cc-number"]').inputValue(), card.number);
});
test('two semantic card numbers with different scores remain ambiguous in readiness and filling', async (t) => {
  const page = await pageFor(t, cardHtml + '<input aria-label="Card number">');
  const ready = await inspectCardReadiness(page);
  assert.equal(ready.ready, false);
  assert.equal(ready.code, 'CHECKOUT_CONTROL_AMBIGUOUS');
  const result = await fillCard(page, card);
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.deepEqual(result.missing, ['number']);
  assert.deepEqual(
    await page
      .locator('[autocomplete="cc-number"],[aria-label="Card number"]')
      .evaluateAll((ns) => ns.map((n) => n.value)),
    ['', '']
  );
});
test('frame read failure is explicit and does not leak exception contents', async (t) => {
  const page = await pageFor(t, iframe(cardHtml));
  failFrameRead(t, page.frames()[1], async () => {
    throw new Error('4242424242424242 cvc=123 https://synthetic.invalid/private');
  });
  const ready = await inspectCardReadiness(page, { deadline: Date.now() + 1500 });
  assert.equal(ready.ready, false);
  assert.equal(ready.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(ready.inspection.complete, false);
  assert.equal(ready.inspection.framesFailed, 1);
  assert.equal(ready.inspection.readPhase, 'frame_scan');
  assert.deepEqual(ready.missing, ['number']);
  const failed = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 1500
  });
  assert.equal(failed.errorCode, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.ok(failed.missing.includes('country'));
  assert.doesNotMatch(
    JSON.stringify({ ready, failed }),
    /4242424242424242|cvc=123|https:|Synthetic Person/
  );
});
test('a transient frame failure discards stale partial candidates before one complete rescan', async (t) => {
  const page = await pageFor(
    t,
    '<input id="obsolete" autocomplete="cc-number">' + iframe(cardHtml)
  );
  const frame = page.frames()[1];
  const locator = frame.locator('input,select,textarea,[role="combobox"]');
  const evaluateAll = locator.evaluateAll.bind(locator);
  let reads = 0;
  failFrameRead(t, frame, async (...args) => {
    if (++reads === 1) {
      await page.locator('#obsolete').evaluate((node) => node.remove());
      throw new Error('Synthetic renderer context changed');
    }
    return evaluateAll(...args);
  });
  const result = await inspectCardReadiness(page, { deadline: Date.now() + 2000 });
  assert.equal(result.ready, true);
  assert.equal(result.inspection.readAttempts, 2);
  assert.equal(result.inspection.framesFailed, 0);
  assert.equal(result.controls.filter((control) => control.fields.includes('number')).length, 1);
  assert.equal(reads, 2);
});
test('the single fresh rescan accommodates a busy renderer without extending the total deadline', async (t) => {
  const page = await pageFor(t, iframe(cardHtml));
  const frame = page.frames()[1];
  const locator = frame.locator('input,select,textarea,[role="combobox"]');
  const evaluateAll = locator.evaluateAll.bind(locator);
  let reads = 0;
  failFrameRead(t, frame, async (...args) => {
    const result = await evaluateAll(...args);
    const delay = ++reads === 1 ? 350 : 700;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return result;
  });
  const started = Date.now();
  const result = await inspectCardReadiness(page, { deadline: started + 3000 });
  assert.equal(result.ready, true);
  assert.equal(result.inspection.readAttempts, 2);
  assert.equal(result.inspection.timedOut, false);
  assert.equal(reads, 2);
  assert.ok(Date.now() - started < 2300);
});
test('one hung frame has a short budget and later frames are still inspected', async (t) => {
  const page = await pageFor(t, iframe('<input>') + iframe(cardHtml));
  failFrameRead(t, page.frames()[1], () => new Promise(() => {}));
  const started = Date.now();
  const result = await inspectCardReadiness(page, { deadline: started + 3600 });
  assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(result.ready, false);
  assert.equal(result.inspection.timedOut, false);
  assert.ok(result.inspection.framesChecked >= 2);
  assert.ok(result.controls.some((control) => control.fields.includes('number')));
  assert.ok(Date.now() - started < 2300);
});
test('global timeout retains missing fields and explicit inspection instead of an empty ambiguity', async () => {
  const source = readFileSync(require.resolve('../checkout-form.cjs'), 'utf8');
  const fixture = (wallClockLag) => {
    const deadline = 1080;
    let clock = 1000;
    const observed = { timerCallbacks: 0, laterFrameReads: 0 };
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      Date: { now: () => clock },
      setTimeout: (callback, delay) =>
        setTimeout(() => {
          // The real budget timer fires; only its observed Date tick is controlled.
          clock = deadline - wallClockLag;
          observed.timerCallbacks++;
          callback();
        }, delay),
      clearTimeout
    });
    const emptySnapshot = () => Promise.resolve({ metas: [], scanned: 0, rejectCounts: {} });
    const frame = (parent, read) => ({
      parentFrame: () => parent,
      frameElement: async () => ({
        evaluate: async () => null,
        dispose: async () => {}
      }),
      getByText: () => ({ count: async () => 0 }),
      locator: () => ({ evaluateAll: read })
    });
    const main = frame(null, emptySnapshot);
    const hung = frame(main, () => new Promise(() => {}));
    const later = frame(main, () => {
      observed.laterFrameReads++;
      return emptySnapshot();
    });
    return {
      form: module.exports,
      page: { isClosed: () => false, frames: () => [main, hung, later] },
      deadline,
      observed
    };
  };
  for (const wallClockLag of [0, 1]) {
    const f = fixture(wallClockLag);
    const result = await f.form.inspectCardReadiness(f.page, { deadline: f.deadline });
    assert.equal(result.code, 'CHECKOUT_FORM_TIMEOUT');
    assert.deepEqual(Array.from(result.missing), ['number']);
    assert.equal(result.inspection.timedOut, true);
    assert.equal(result.inspection.complete, false);
    assert.equal(f.observed.timerCallbacks, 1);
    assert.equal(f.observed.laterFrameReads, 0);

    const b = fixture(wallClockLag);
    const billing = await b.form.fillBilling(b.page, address, 'Synthetic Person', {
      deadline: b.deadline
    });
    assert.equal(billing.errorCode, 'CHECKOUT_FORM_TIMEOUT');
    assert.ok(billing.missing.includes('line1'));
    assert.equal(billing.inspection.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(b.observed.laterFrameReads, 0);
  }
});
test('selected-node eligibility timeout is a read failure while the form budget remains', async (t) => {
  const page = await pageFor(t, cardHtml);
  const frame = page.mainFrame(),
    locator = frame.locator;
  frame.locator = function (selector, ...options) {
    const result = locator.call(this, selector, ...options);
    if (selector.includes('[autocomplete="cc-number"]')) {
      const handles = result.elementHandles.bind(result);
      result.elementHandles = async () => {
        const list = await handles();
        for (const item of list) item.evaluate = () => new Promise(() => {});
        return list;
      };
    }
    return result;
  };
  t.after(() => {
    frame.locator = locator;
  });
  const started = Date.now();
  const result = await inspectCardReadiness(page, { deadline: started + 3600 });
  assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(result.inspection.timedOut, false);
  assert.deepEqual(result.missing, ['number']);
  assert.equal(result.inspection.readPhase, 'candidate_eligibility');
  assert.ok(Date.now() - started < 2300);
});
test('one delayed eligibility read rediscovers a replaced card node before filling', async (t) => {
  const page = await pageFor(t, cardHtml);
  delayOneNumberRead(t, page, 'candidate_eligibility', () =>
    page.locator('[autocomplete="cc-number"]').evaluate((node) => {
      node.replaceWith(node.cloneNode());
    })
  );
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(result.ok, true);
  assert.equal(await page.locator('[autocomplete="cc-number"]').inputValue(), card.number);
});
test('one delayed value read reacquires the current node rather than using its old handle', async (t) => {
  const page = await pageFor(t, cardHtml);
  delayOneNumberRead(t, page, 'value', () =>
    page.locator('[autocomplete="cc-number"]').evaluate((node) => {
      const replacement = node.cloneNode();
      replacement.value = '4111111111111111';
      node.replaceWith(replacement);
    })
  );
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(result.ok, true);
  assert.equal(await page.locator('[autocomplete="cc-number"]').inputValue(), card.number);
});
test('a new visible card duplicate during a delayed read stops before writing', async (t) => {
  const page = await pageFor(t, cardHtml);
  delayOneNumberRead(t, page, 'candidate_eligibility', () =>
    page.locator('[autocomplete="cc-number"]').evaluate((node) => {
      node.after(node.cloneNode());
    })
  );
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_AMBIGUOUS');
  assert.deepEqual(
    await page
      .locator('[autocomplete="cc-number"]')
      .evaluateAll((nodes) => nodes.map((n) => n.value)),
    ['', '']
  );
});
test('closed page and aborted readiness report controlled causes and pending fields', async (t) => {
  const page = await pageFor(t, cardHtml);
  const controller = new AbortController();
  controller.abort();
  const aborted = await inspectCardReadiness(page, { signal: controller.signal });
  assert.equal(aborted.code, 'CHECKOUT_FORM_ABORTED');
  assert.equal(aborted.inspection.aborted, true);
  await page.close();
  const ready = await inspectCardReadiness(page);
  assert.equal(ready.code, 'CHECKOUT_PAGE_CLOSED');
  assert.deepEqual(ready.missing, ['number']);
  const result = await fillCard(page, card);
  assert.equal(result.errorCode, 'CHECKOUT_PAGE_CLOSED');
  assert.ok(result.missing.includes('number'));
  assert.equal(result.inspection.pageClosed, true);
});
test('number verified before expiry timeout is not reported as the missing field', async (t) => {
  const page = await pageFor(t, '<input autocomplete="cc-number">');
  const result = await fillCard(page, card, { deadline: Date.now() + 650 });
  assert.equal(result.errorCode, 'CHECKOUT_FORM_TIMEOUT');
  assert.ok(result.missing.includes('expiry'));
  assert.ok(result.missing.includes('cvc'));
  assert.equal(result.missing.includes('number'), false);
});
test('readiness and diagnostic metadata contain no values, identifiers, labels or URLs', async (t) => {
  const page = await pageFor(
    t,
    '<input autocomplete="cc-number" id="card-number-4242424242424242" aria-label="Card number 4242424242424242" placeholder="https://synthetic.invalid/secret" value="4242424242424242">'
  );
  const result = await inspectCardReadiness(page);
  const metadata = await diagnostic(page);
  assert.equal(result.ready, true);
  for (const controls of [result.controls, metadata])
    for (const control of controls)
      assert.deepEqual(Object.keys(control).sort(), [
        'fields',
        'readOnly',
        'required',
        'role',
        'scope',
        'tag'
      ]);
  assert.doesNotMatch(
    JSON.stringify({ result, metadata }),
    /4242424242424242|https:|placeholder|"value"|"label"|"id"/
  );
  const custom = await pageFor(
    t,
    '<card-4242424242424242 role="combobox" aria-label="Card number" style="display:block;width:200px;height:30px"></card-4242424242424242>'
  );
  const projected = await diagnostic(custom);
  assert.equal(projected[0].tag, 'other');
  assert.doesNotMatch(JSON.stringify(projected), /4242424242424242/);
});
test('page load failure requires visible exact text and excludes hidden templates and frames', async (t) => {
  for (const html of [
    '',
    '<p>Message: Content failed to load, please retry</p>',
    '<template><p>Content failed to load</p></template>',
    '<p hidden>Content failed to load</p>',
    cardHtml + '<p hidden>Content failed to load</p>',
    '<p style="opacity:0">Content failed to load</p>',
    `<section inert>${iframe('<p>Content failed to load</p>')}</section>`
  ]) {
    assert.equal(await checkoutPageLoadFailed(await pageFor(t, html)), false);
  }
  assert.equal(
    await checkoutPageLoadFailed(await pageFor(t, '<p>Content failed to load</p>')),
    true
  );
  assert.equal(
    await checkoutPageLoadFailed(await pageFor(t, iframe(iframe('<p>Content failed to load</p>')))),
    true
  );
});
test('load failure probe retries one 350ms real browser read from a fresh frame snapshot', async (t) => {
  const page = await pageFor(t, iframe('<p>Content failed to load</p>'));
  let reads = 0;
  interceptLoadFailureCount(t, page.frames()[1], async (count) => {
    const result = await count();
    if (++reads === 1) await new Promise((resolve) => setTimeout(resolve, 350));
    return result;
  });
  const started = Date.now();
  assert.equal(await checkoutPageLoadFailed(page, { deadline: started + 3000 }), true);
  assert.equal(reads, 2);
  assert.ok(Date.now() - started < 2300);
});
test('a persistently hung load failure probe throws after two bounded reads instead of returning false', async (t) => {
  const page = await pageFor(t, '<p>Content failed to load</p>');
  let reads = 0;
  interceptLoadFailureCount(t, page.mainFrame(), () => {
    reads++;
    return new Promise(() => {});
  });
  const started = Date.now();
  await assert.rejects(checkoutPageLoadFailed(page, { deadline: started + 3000 }), (error) => {
    assert.equal(error.code, 'CHECKOUT_CONTROL_READ_FAILED');
    assert.equal(error.readPhase, 'frame_scan');
    assert.equal(error.inspection.readAttempts, 2);
    assert.equal(error.inspection.complete, false);
    assert.equal(error.inspection.timedOut, false);
    return true;
  });
  assert.equal(reads, 2);
  assert.ok(Date.now() - started < 2300);
});
for (const stop of ['abort', 'closed', 'deadline', 'fractional deadline']) {
  test(`load failure probe preserves ${stop} without a retry or a false negative`, async (t) => {
    const page = await pageFor(t, '<p>Content failed to load</p>');
    const controller = new AbortController();
    let entered;
    const reading = new Promise((resolve) => (entered = resolve));
    let reads = 0;
    interceptLoadFailureCount(t, page.mainFrame(), () => {
      reads++;
      entered();
      return new Promise(() => {});
    });
    const pending = checkoutPageLoadFailed(page, {
      deadline:
        Date.now() + (stop === 'deadline' ? 80 : stop === 'fractional deadline' ? 80.75 : 3000),
      signal: controller.signal
    });
    const rejected = assert.rejects(pending, {
      code:
        stop === 'abort'
          ? 'CHECKOUT_FORM_ABORTED'
          : stop === 'closed'
            ? 'CHECKOUT_PAGE_CLOSED'
            : 'CHECKOUT_FORM_TIMEOUT'
    });
    await reading;
    if (stop === 'abort') controller.abort();
    if (stop === 'closed') await page.close();
    await rejected;
    assert.equal(reads, 1);
  });
}
test('an incomplete load failure diagnostic preserves the structured original field failure', async (t) => {
  const page = await pageFor(t, cardHtml);
  interceptLoadFailureCount(t, page.mainFrame(), () => new Promise(() => {}));
  const result = await fillCard(page, { ...card, cvc: '' }, { deadline: Date.now() + 3000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHECKOUT_FORM_DATA_MISSING');
  assert.deepEqual(result.missing, ['cvc']);
});
test('card fields replaced by a load failure stop before the shared form deadline', async (t) => {
  const page = await pageFor(t, '<input autocomplete="cc-number">');
  await page.locator('input').evaluate((n) =>
    n.addEventListener(
      'input',
      () => {
        document.body.innerHTML = '<p>Content failed to load</p>';
      },
      { once: true }
    )
  );
  const started = Date.now();
  const result = await fillCard(page, card, { deadline: started + 6000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHECKOUT_CONTENT_LOAD_FAILED');
  assert.equal(result.inspection.contentLoadFailed, true);
  assert.ok(result.missing.length > 0);
  assert.ok(Date.now() - started < 3000);
});
test('country replacement by a load failure stops billing with pending address fields', async (t) => {
  const page = await pageFor(t, countryHtml + addressHtml);
  await page.locator('select[autocomplete="billing country"]').evaluate((n) =>
    n.addEventListener('change', () => {
      document.body.innerHTML = '<p>Content failed to load</p>';
    })
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 6000
  });
  assert.equal(result.errorCode, 'CHECKOUT_CONTENT_LOAD_FAILED');
  assert.equal(result.inspection.contentLoadFailed, true);
  assert.ok(result.missing.includes('line1'));
});

test('single mixed iframe identifies card controls by meaning, leaves email untouched', async (t) => {
  const page = await pageFor(t, iframe(cardHtml + countryHtml + addressHtml));
  assert.equal((await fillCard(page, card)).ok, true);
  assert.equal(await page.frames()[1].locator('[autocomplete=email]').inputValue(), '');
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
});
test('separate and nested iframes and hidden duplicates are supported', async (t) => {
  const page = await pageFor(
    t,
    '<input type="hidden" autocomplete="cc-number">' +
      iframe('<input autocomplete="cc-exp">') +
      iframe('<input autocomplete="cc-number">') +
      iframe('<input autocomplete="cc-csc">') +
      iframe(countryHtml + addressHtml)
  );
  assert.equal((await fillCard(page, card)).ok, true);
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
});
test('country replacing address controls triggers new discovery and readback', async (t) => {
  const page = await pageFor(t, countryHtml + '<section id="fields"></section>');
  await page.locator('select').evaluate(
    (n, html) =>
      n.addEventListener('change', () => {
        document.querySelector('#fields').innerHTML = html;
      }),
    addressHtml
  );
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
});
test('required invalid field cannot be treated as filled', async (t) => {
  const page = await pageFor(
    t,
    countryHtml +
      addressHtml.replace(
        'autocomplete="billing postal-code"',
        'autocomplete="billing postal-code" pattern="[0-9]{9}" required'
      )
  );
  const result = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 700
  });
  assert.equal(result.ok, false);
});
test('ambiguous visible card inputs fail without putting card data into either', async (t) => {
  const page = await pageFor(t, cardHtml + '<input autocomplete="cc-number">');
  assert.equal((await fillCard(page, card)).ok, false);
  assert.deepEqual(
    await page
      .locator('[autocomplete="cc-number"]')
      .evaluateAll((nodes) => nodes.map((n) => n.value)),
    ['', '']
  );
});
test('missing fields stop within one shared deadline and do not leak values in diagnostics', async (t) => {
  const page = await pageFor(t, cardHtml);
  const start = Date.now();
  const result = await fillBilling(page, address, 'Synthetic Person', { deadline: start + 650 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - start < 2500);
  assert.doesNotMatch(JSON.stringify(result), /4242424242424242|Synthetic Person|97201/);
});
test('missing existing billing data fails immediately instead of inventing it', async (t) => {
  const page = await pageFor(t, countryHtml + addressHtml);
  assert.equal((await fillBilling(page, {}, '')).ok, false);
  assert.equal(await page.locator('[autocomplete="billing name"]').inputValue(), '');
});

test('observed Link name and state auxiliary never compete with explicit billing controls', async (t) => {
  const page = await pageFor(
    t,
    '<input id="payment-linkLegalNameInput" name="linkLegalName" autocomplete="billing name" aria-label="Full name (optional)">' +
      countryHtml +
      addressHtml
        .replace(
          '<input autocomplete="billing name">',
          '<input id="billingAddress-nameInput" autocomplete="billing name" required>'
        )
        .replace(
          '<select autocomplete="billing address-level1">',
          '<input autocomplete="billing address-level1"><select id="billingAddress-administrativeAreaInput" autocomplete="billing address-level1">'
        )
  );
  const result = await fillBilling(page, address, 'Synthetic Person');
  assert.equal(result.ok, true);
  assert.equal(await page.locator('#payment-linkLegalNameInput').inputValue(), '');
  assert.equal(await page.locator('#billingAddress-nameInput').inputValue(), 'Synthetic Person');
  assert.equal(await page.locator('input[autocomplete="billing address-level1"]').inputValue(), '');
  assert.equal(await page.locator('#billingAddress-administrativeAreaInput').inputValue(), 'OR');
});
test('billing group disambiguates names without relying on input order or unique autocomplete', async (t) => {
  const page = await pageFor(
    t,
    '<section aria-label="Contact"><input autocomplete="billing name"></section>' +
      '<section aria-label="Billing address">' +
      countryHtml +
      addressHtml +
      '</section>'
  );
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
  assert.equal(await page.locator('[aria-label="Contact"] input').inputValue(), '');
  assert.equal(
    await page
      .locator('[aria-label="Billing address"] input[autocomplete="billing name"]')
      .inputValue(),
    'Synthetic Person'
  );
});
test('two actual billing names still fail closed and diagnostics contain no entered values', async (t) => {
  const page = await pageFor(t, countryHtml + addressHtml + '<input autocomplete="billing name">');
  const result = await fillBilling(page, address, 'Synthetic Person');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['name']);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic Person|97201|1 Synthetic Street/);
});
test('inert explicit duplicates cannot defeat an active billing field', async (t) => {
  const page = await pageFor(
    t,
    '<div inert><input id="billingAddress-nameInput" autocomplete="billing name"></div>' +
      countryHtml +
      addressHtml
  );
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
  assert.equal(await page.locator('[inert] input').inputValue(), '');
});
test('payment limit compares exact decimals and rejects missing/conflicting amounts', () => {
  const limit = { currency: 'PHP', maxAmount: '9990.0000' };
  assert.doesNotThrow(() => assertPaymentLimit(limit, { currency: 'PHP', amount: '9990.00' }));
  assert.doesNotThrow(() => assertPaymentLimit(limit, { currency: 'PHP', amount: '8919.64' }));
  for (const due of [
    null,
    { currency: 'USD', amount: '1' },
    { currency: 'PHP', amount: '9990.0001' }
  ])
    assert.throws(() => assertPaymentLimit(limit, due));
  assert.throws(() =>
    assertPaymentLimit({ currency: 'PHP', maxAmount: '1e4' }, { currency: 'PHP', amount: '1' })
  );
});

test('nested iframe with a billing form is discovered', async (t) => {
  const page = await pageFor(t, iframe(iframe(countryHtml + addressHtml)));
  assert.equal((await fillBilling(page, address, 'Synthetic Person')).ok, true);
});
test('late expiry controls share the card and billing deadline', async (t) => {
  const page = await pageFor(t, '<input autocomplete="cc-number"><input autocomplete="cc-csc">');
  await page.evaluate(() =>
    setTimeout(() => {
      const input = document.createElement('input');
      input.autocomplete = 'cc-exp';
      document.body.append(input);
    }, 300)
  );
  const start = Date.now(),
    deadline = start + 1000;
  assert.equal((await fillCard(page, card, { deadline })).ok, true);
  assert.equal((await fillBilling(page, address, 'Synthetic Person', { deadline })).ok, false);
  assert.ok(Date.now() - start < 2400);
});
test('stable quote requires consecutive identical official totals after recalculation', async () => {
  const { stableDue } = require('../checkout-form.cjs');
  let now = Date.now(),
    calls = 0;
  const page = {
    waitForTimeout: async () => {
      calls++;
    }
  };
  const due = await stableDue(
    page,
    async () => ({ currency: 'PHP', amount: calls < 2 ? '9990.00' : '8919.64' }),
    now + 1000
  );
  assert.equal(due.amount, '8919.64');
  assert.ok(calls >= 5);
});

test('readonly country combobox uses its options and verifies the selection', async (t) => {
  const page = await pageFor(
    t,
    '<input role="combobox" readonly aria-label="Country" aria-controls="country-choice" value="PH">' +
      addressHtml
  );
  await page.locator('[role="combobox"]').evaluate((n) =>
    n.addEventListener('keydown', () => {
      const choice = document.createElement('div');
      choice.id = 'country-choice';
      choice.setAttribute('role', 'option');
      choice.textContent = 'United States';
      choice.addEventListener('click', () => {
        n.value = 'US';
        choice.remove();
      });
      document.body.append(choice);
    })
  );
  assert.equal(
    (await fillBilling(page, address, 'Synthetic Person', { deadline: Date.now() + 4000 })).ok,
    true
  );
});

test('separate expiry month and four-digit year controls use their own semantics', async (t) => {
  const page = await pageFor(
    t,
    '<input autocomplete="cc-number"><select autocomplete="cc-exp-month"><option value="12">December</option></select><input autocomplete="cc-exp-year" pattern="[0-9]{4}" required><input autocomplete="cc-csc">'
  );
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 4000 })).ok, true);
  assert.equal(await page.locator('[autocomplete="cc-exp-year"]').inputValue(), '2030');
});

test('expiry appearing only after entering the number does not deadlock', async (t) => {
  const page = await pageFor(t, '<input autocomplete="cc-number"><input autocomplete="cc-csc">');
  await page.locator('[autocomplete="cc-number"]').evaluate((n) =>
    n.addEventListener('input', () => {
      if (!document.querySelector('[autocomplete="cc-exp"]')) {
        const el = document.createElement('input');
        el.autocomplete = 'cc-exp';
        document.body.append(el);
      }
    })
  );
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 4000 })).ok, true);
});

test('country change clearing card fields is detected and repaired within the same deadline', async (t) => {
  const { verifyCard } = require('../checkout-form.cjs');
  const page = await pageFor(t, cardHtml + countryHtml + addressHtml),
    deadline = Date.now() + 5000;
  await page.locator('[autocomplete="billing country"]').evaluate((n) =>
    n.addEventListener('change', () => {
      for (const input of document.querySelectorAll('input[autocomplete^="cc-"]')) input.value = '';
    })
  );
  assert.equal((await fillCard(page, card, { deadline })).ok, true);
  assert.equal((await fillBilling(page, address, 'Synthetic Person', { deadline })).ok, true);
  assert.ok((await verifyCard(page, card, { deadline })).length > 0);
  assert.equal((await fillCard(page, card, { deadline })).ok, true);
  assert.equal((await fillBilling(page, address, 'Synthetic Person', { deadline })).ok, true);
  assert.deepEqual(await verifyCard(page, card, { deadline }), []);
});

test('actual submit boundary rereads the official amount and stops before any click', async (t) => {
  const rpc = require('../rpc.cjs'),
    original = rpc.beforeExternalSubmit;
  let calls = 0;
  rpc.beforeExternalSubmit = async () => {
    calls++;
    throw Object.assign(new Error('SYNTHETIC_STOP_AT_RPC'), { code: 'LEASE_LOST' });
  };
  const modulePath = require.resolve('../upstream/stripe-payment');
  delete require.cache[modulePath];
  const stripe = require(modulePath);
  try {
    for (const [due, quoted, error, count] of [
      ['10000.00', '9990.00', /付款上限/, 0],
      ['9000.00', '8919.64', /报价已变化/, 0],
      ['9990.00', '9990.00', /SYNTHETIC_STOP_AT_RPC/, 1]
    ]) {
      const page = await pageFor(t, '');
      await page.route('https://chatgpt.com/checkout/online-checkout-synthetic', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<p>Due today PHP ${due}</p><button onclick="window.didClick=true">Subscribe</button>`
        })
      );
      await page.goto('https://chatgpt.com/checkout/online-checkout-synthetic');
      calls = 0;
      await assert.rejects(
        () =>
          stripe.finalizeCheckoutPayment(page, 'Synthetic Person', {
            paymentContext: { currency: 'PHP', amount: quoted },
            paymentLimit: { currency: 'PHP', maxAmount: '9990.00' }
          }),
        error
      );
      assert.equal(calls, count);
      assert.equal(await page.evaluate(() => Boolean(window.didClick)), false);
    }
  } finally {
    rpc.beforeExternalSubmit = original;
    delete require.cache[modulePath];
  }
});

for (const phase of ['locate', 'precheck', 'input', 'readback'])
  test(`fill diagnostics identify expiry ${phase} without field values or payment`, async (t) => {
    const page = await pageFor(t, cardHtml + '<button type="submit">Pay</button>');
    const frame = page.mainFrame();
    const original = frame.locator;
    let scans = 0,
      expiryReads = 0;
    frame.locator = function (selector, ...args) {
      const locator = original.call(this, selector, ...args);
      if (phase === 'locate' && selector === 'input,select,textarea,[role="combobox"]') {
        const scan = locator.evaluateAll.bind(locator);
        locator.evaluateAll = async (...readArgs) => {
          if (++scans >= 3) throw new Error('PRIVATE_RAW_ERROR');
          return scan(...readArgs);
        };
      }
      if (selector.includes('[autocomplete="cc-exp"]')) {
        const getHandles = locator.elementHandles.bind(locator);
        locator.elementHandles = async (...handleArgs) => {
          const handles = await getHandles(...handleArgs);
          for (const handle of handles) {
            if (phase === 'input')
              handle.fill = async () => {
                throw Object.assign(new Error('PRIVATE_RAW_ERROR'), {
                  code: 'CHECKOUT_CONTROL_READ_FAILED',
                  readPhase: 'control_read'
                });
              };
            const evaluate = handle.evaluate.bind(handle);
            handle.evaluate = async (...readArgs) => {
              if (
                (phase === 'precheck' && readArgs[1]?.control === true) ||
                (phase === 'readback' &&
                  String(readArgs[0]).includes('aria-valuetext') &&
                  ++expiryReads >= 2)
              )
                throw Object.assign(new Error('PRIVATE_RAW_ERROR'), {
                  code: 'CHECKOUT_CONTROL_READ_FAILED'
                });
              return evaluate(...readArgs);
            };
          }
          return handles;
        };
      }
      return locator;
    };
    t.after(() => {
      frame.locator = original;
    });
    const result = await fillCard(page, card, { deadline: Date.now() + 5000 });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'CHECKOUT_CONTROL_READ_FAILED');
    const evidence = require('../unpaid-validation.cjs').safeFormDiagnostics(
      result.formDiagnostics
    );
    const failed = evidence.steps.findLast((step) => step.state === 'failed');
    assert.equal(failed.field, 'expiry');
    assert.equal(failed.phase, phase);
    assert.equal(evidence.inspection.complete, false);
    assert.equal(
      evidence.steps.some(
        (step) => step.field === 'number' && step.phase === 'readback' && step.matched === true
      ),
      true
    );
    assert.equal(JSON.stringify(evidence).includes('PRIVATE_RAW_ERROR'), false);
    for (const secret of [card.number, card.expiry, card.cvc])
      assert.equal(JSON.stringify(evidence).includes(JSON.stringify(secret)), false);
    if (phase === 'locate') {
      assert.equal(await page.locator('[autocomplete="cc-csc"]').inputValue(), '');
      assert.deepEqual(result.missing, ['expiry', 'cvc']);
      assert.equal(
        evidence.steps.some((step) => step.field === 'cvc'),
        false
      );
    }
  });

for (const [message, name, reason] of [
  ['SYNTHETIC_PRIVATE', 'TimeoutError', 'timeout'],
  ['Frame was detached SYNTHETIC_PRIVATE', 'Error', 'detached'],
  ['Execution context was destroyed SYNTHETIC_PRIVATE', 'Error', 'context_destroyed']
])
  test(`ordinary load precheck records ${reason} without an observer`, async (t) => {
    const page = await pageFor(t, '<main>Payment</main>');
    let reads = 0;
    interceptLoadFailureCount(t, page.mainFrame(), async () => {
      reads++;
      throw Object.assign(new Error(message), { name });
    });
    await assert.rejects(checkoutPageLoadFailed(page, { deadline: Date.now() + 4000 }), (error) => {
      assert.equal(error.code, 'CHECKOUT_CONTROL_READ_FAILED');
      assert.equal(error.inspection.readPhase, 'frame_scan');
      assert.equal(error.inspection.readAttempts, 2);
      assert.equal(error.inspection.timedOut, false);
      assert.deepEqual(error.inspection.lastReadFailure, {
        phase: 'load_state',
        reason,
        probe: 'load_precheck',
        readOperation: 'load_error_count',
        frameKind: 'main',
        frameId: 1,
        count: 1
      });
      assert.deepEqual(error.inspection.readFailures, [error.inspection.lastReadFailure]);
      assert.doesNotMatch(JSON.stringify(error.inspection), /SYNTHETIC_PRIVATE/);
      return true;
    });
    assert.equal(reads, 2);
  });
test('ordinary load precheck distinguishes error count from error visibility', async (t) => {
  const page = await pageFor(t, '<p>Content failed to load</p>');
  const frame = page.mainFrame(),
    original = frame.getByText;
  frame.getByText = function (...args) {
    const locator = original.apply(this, args);
    locator.nth = () => ({
      evaluate: async () => {
        throw new Error('Frame was detached SYNTHETIC_PRIVATE');
      }
    });
    return locator;
  };
  t.after(() => {
    frame.getByText = original;
  });
  await assert.rejects(checkoutPageLoadFailed(page, { deadline: Date.now() + 4000 }), (error) => {
    assert.equal(error.inspection.lastReadFailure.readOperation, 'load_error_visibility');
    assert.equal(error.inspection.lastReadFailure.reason, 'detached');
    return true;
  });
});
for (const operation of ['frame_element', 'owner_visibility'])
  test(`ordinary load precheck records embedded ${operation} without skipping the frame`, async (t) => {
    const page = await pageFor(t, iframe('<p>Payment frame</p>'));
    const frame = page.frames()[1],
      original = frame.frameElement;
    frame.frameElement = async function (...args) {
      if (operation === 'frame_element')
        throw new Error('Execution context was destroyed SYNTHETIC_PRIVATE');
      const owner = await original.apply(this, args);
      owner.evaluate = async () => {
        throw new Error('Execution context was destroyed SYNTHETIC_PRIVATE');
      };
      return owner;
    };
    t.after(() => {
      frame.frameElement = original;
    });
    await assert.rejects(checkoutPageLoadFailed(page, { deadline: Date.now() + 4000 }), (error) => {
      const failure = error.inspection.lastReadFailure;
      assert.equal(failure.readOperation, operation);
      assert.equal(failure.probe, 'load_precheck');
      assert.equal(failure.phase, 'frame_owner');
      assert.equal(failure.frameKind, 'embedded');
      assert.equal(failure.reason, 'context_destroyed');
      assert.equal(error.inspection.complete, false);
      return true;
    });
  });
test('ordinary load precheck preserves frozen original errors and still records their operation', async (t) => {
  const page = await pageFor(t, '<main>Payment</main>');
  const original = Object.freeze(
    Object.assign(new Error('SYNTHETIC_PRIVATE'), { name: 'TimeoutError' })
  );
  interceptLoadFailureCount(t, page.mainFrame(), async () => {
    throw original;
  });
  await assert.rejects(checkoutPageLoadFailed(page, { deadline: Date.now() + 4000 }), (error) => {
    assert.equal(error.inspection.lastReadFailure.readOperation, 'load_error_count');
    assert.equal(error.inspection.lastReadFailure.reason, 'timeout');
    return true;
  });
});
test('ordinary load precheck failure does not claim that number scanning found a missing field', async (t) => {
  const page = await pageFor(t, '<main>Payment</main>');
  interceptLoadFailureCount(t, page.mainFrame(), async () => {
    throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { name: 'TimeoutError' });
  });
  const result = await require('../upstream/human-verification').clearHumanVerification(page, {
    phase: 'checkout-open',
    requireCheckoutReady: true,
    checkCheckoutLoad: true,
    maxWaitMs: 4000
  });
  assert.equal(result.cleared, false);
  assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.deepEqual(result.missing, []);
  assert.equal(result.inspection.lastReadFailure.probe, 'load_precheck');
});
