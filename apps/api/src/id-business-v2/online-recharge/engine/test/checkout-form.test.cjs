'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('../upstream/node_modules/playwright');
const {
  fillCard,
  fillBilling,
  inspectCardReadiness,
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
test('readiness excludes hidden and inert iframe ancestors, including nested frames', async (t) => {
  for (const html of [
    iframe(cardHtml).replace('<iframe', '<iframe hidden'),
    `<section style="display:none">${iframe(iframe(cardHtml))}</section>`,
    `<section inert>${iframe(iframe(cardHtml))}</section>`,
    `<section aria-hidden="true">${iframe(cardHtml)}</section>`,
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
test('global timeout retains missing fields and explicit inspection instead of an empty ambiguity', async (t) => {
  const page = await pageFor(t, iframe(cardHtml));
  failFrameRead(t, page.frames()[1], () => new Promise(() => {}));
  const result = await inspectCardReadiness(page, { deadline: Date.now() + 80 });
  assert.equal(result.code, 'CHECKOUT_FORM_TIMEOUT');
  assert.deepEqual(result.missing, ['number']);
  assert.equal(result.inspection.timedOut, true);
  const billing = await fillBilling(page, address, 'Synthetic Person', {
    deadline: Date.now() + 80
  });
  assert.equal(billing.errorCode, 'CHECKOUT_FORM_TIMEOUT');
  assert.ok(billing.missing.includes('line1'));
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
    '<input role="combobox" readonly aria-label="Country" value="PH">' + addressHtml
  );
  await page.locator('[role="combobox"]').evaluate((n) =>
    n.addEventListener('keydown', () => {
      const choice = document.createElement('div');
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
