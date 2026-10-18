'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('../upstream/node_modules/playwright');
const { inspectCardReadiness, fillCard, verifyCard } = require('../checkout-form.cjs');

const card = { number: '4242424242424242', expiry: '12/30', cvc: '123' };
const cardHtml = (attributes = '', populated = false) =>
  `<input autocomplete="cc-number" ${attributes} value="${populated ? card.number : ''}">` +
  `<input autocomplete="cc-exp" value="${populated ? card.expiry : ''}">` +
  `<input autocomplete="cc-csc" value="${populated ? card.cvc : ''}">`;
const iframe = (html, attributes = '', style = '') =>
  `<iframe ${attributes} style="display:block;width:700px;height:300px;${style}" srcdoc="${html
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></iframe>`;
const modal = (contents = 'Synthetic verification') =>
  `<div role="dialog" aria-modal="true" style="position:fixed;right:8px;bottom:8px;padding:12px;background:white">${contents}</div>`;
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
  const context = await browser.newContext({
    viewport: { width: 1100, height: 720 },
    serviceWorkers: 'block'
  });
  await context.route('**/*', (route) => route.abort());
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(html);
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      window.syntheticActions = { click: 0, pointerdown: 0, mousedown: 0, focusin: 0, input: 0 };
      for (const name of Object.keys(window.syntheticActions)) {
        document.addEventListener(
          name,
          () => {
            window.syntheticActions[name]++;
          },
          true
        );
      }
    });
  }
  return page;
}

async function actions(page) {
  const total = { click: 0, pointerdown: 0, mousedown: 0, focusin: 0, input: 0 };
  for (const frame of page.frames()) {
    const current = await frame.evaluate(() => window.syntheticActions || {});
    for (const key of Object.keys(total)) total[key] += current[key] || 0;
  }
  return total;
}

async function assertNoActions(page) {
  assert.deepEqual(await actions(page), {
    click: 0,
    pointerdown: 0,
    mousedown: 0,
    focusin: 0,
    input: 0
  });
}

async function assertEmptyNumbers(page) {
  for (const frame of page.frames()) {
    const values = await frame
      .locator('input[autocomplete="cc-number"]')
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    assert.ok(
      values.every((value) => value === ''),
      'blocked card controls stay empty'
    );
  }
}

async function assertNotVerified(page) {
  try {
    const missing = await verifyCard(page, card, { deadline: Date.now() + 900 });
    assert.ok(missing.length > 0, 'a blocked form must not pass final readback');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.ok(error.code, 'verification stops with a controlled error');
  }
}

async function assertBlocked(page) {
  const readiness = await inspectCardReadiness(page, { deadline: Date.now() + 900 });
  assert.equal(readiness.ready, false);
  const result = await fillCard(page, card, { deadline: Date.now() + 650 });
  assert.equal(result.ok, false);
  await assertEmptyNumbers(page);
  await assertNoActions(page);
}

for (const [name, html] of [
  ['control', cardHtml('aria-hidden="true"')],
  ['ancestor', `<section aria-hidden="true">${cardHtml()}</section>`],
  ['iframe owner', iframe(cardHtml(), 'aria-hidden="true"')],
  [
    'nested iframe owners and ancestors',
    `<section aria-hidden="true">${iframe(
      `<section aria-hidden="true">${iframe(cardHtml('aria-hidden="true"'), 'aria-hidden="true"', 'width:600px;height:180px;')}</section>`,
      'aria-hidden="true"'
    )}</section>`
  ]
]) {
  test(`physical ${name} ignores pure ARIA hiding without interaction during readiness`, async (t) => {
    const page = await pageFor(t, html);
    assert.equal((await inspectCardReadiness(page, { deadline: Date.now() + 1800 })).ready, true);
    await assertNoActions(page);
    assert.equal((await fillCard(page, card, { deadline: Date.now() + 3500 })).ok, true);
    assert.deepEqual(await verifyCard(page, card, { deadline: Date.now() + 1800 }), []);
    assert.equal((await actions(page)).click, 0);
  });
}

for (const [name, html] of [
  ['hidden ancestor', `<section hidden style="display:block">${cardHtml()}</section>`],
  ['inert ancestor', `<section inert>${cardHtml()}</section>`],
  ['disabled field', cardHtml('disabled')],
  ['readonly field', cardHtml('readonly')],
  ['ARIA disabled ancestor', `<section aria-disabled="true">${cardHtml()}</section>`],
  ['display none', `<section style="display:none">${cardHtml()}</section>`],
  ['zero opacity', `<section style="opacity:0">${cardHtml()}</section>`],
  ['inert iframe owner ancestor', `<section inert>${iframe(iframe(cardHtml()))}</section>`],
  ['hidden iframe owner ancestor', `<section hidden>${iframe(cardHtml())}</section>`]
]) {
  test(`physical eligibility preserves ${name}`, async (t) => {
    const page = await pageFor(t, html);
    await assertBlocked(page);
  });
}

test('a displayed ARIA modal excludes an otherwise clickable background form', async (t) => {
  const page = await pageFor(t, cardHtml() + modal());
  await assertBlocked(page);
});

test('a displayed ARIA modal permits its own controls and excludes background duplicates', async (t) => {
  const page = await pageFor(t, cardHtml() + modal(cardHtml('aria-hidden="true"')));
  assert.equal((await inspectCardReadiness(page)).ready, true);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.equal(await page.locator('body > input[autocomplete="cc-number"]').inputValue(), '');
  assert.equal(
    await page.locator('[role="dialog"] input[autocomplete="cc-number"]').inputValue(),
    card.number
  );
  assert.deepEqual(await verifyCard(page, card), []);
  assert.equal((await actions(page)).click, 0);
});

test('a native modal excludes background controls without an explicit inert attribute', async (t) => {
  const page = await pageFor(t, cardHtml() + '<dialog>Synthetic verification</dialog>');
  await page.locator('dialog').evaluate((node) => node.showModal());
  for (const frame of page.frames())
    await frame.evaluate(() => {
      for (const key of Object.keys(window.syntheticActions)) window.syntheticActions[key] = 0;
    });
  await assertBlocked(page);
});

test('a native modal permits card controls inside itself', async (t) => {
  const page = await pageFor(t, cardHtml() + `<dialog>${cardHtml()}</dialog>`);
  await page.locator('dialog').evaluate((node) => node.showModal());
  await page.evaluate(() => {
    for (const key of Object.keys(window.syntheticActions)) window.syntheticActions[key] = 0;
  });
  assert.equal((await inspectCardReadiness(page)).ready, true);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.equal(await page.locator('body > input[autocomplete="cc-number"]').inputValue(), '');
  assert.deepEqual(await verifyCard(page, card), []);
});

for (const order of ['lower first', 'upper first']) {
  test(`stacked native modals follow showModal order with ${order} in the DOM`, async (t) => {
    const lower = `<dialog id="lower">${cardHtml()}</dialog>`;
    const upper = `<dialog id="upper">${cardHtml()}</dialog>`;
    const page = await pageFor(t, order === 'lower first' ? lower + upper : upper + lower);
    await page.evaluate(() => {
      document.querySelector('#lower').showModal();
      document.querySelector('#upper').showModal();
      for (const key of Object.keys(window.syntheticActions)) window.syntheticActions[key] = 0;
    });
    assert.equal((await inspectCardReadiness(page)).ready, true);
    await assertNoActions(page);
    assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
    assert.equal(
      await page.locator('#upper input[autocomplete="cc-number"]').inputValue(),
      card.number
    );
    assert.deepEqual(
      await page.locator('#lower input').evaluateAll((nodes) => nodes.map((node) => node.value)),
      ['', '', '']
    );
    assert.deepEqual(await verifyCard(page, card), []);
    assert.equal((await actions(page)).click, 0);
  });
}

const portalModal = (id, contents, zIndex) =>
  `<div id="${id}" role="dialog" aria-modal="true" style="position:fixed;left:40px;top:40px;width:850px;height:240px;padding:24px;box-sizing:border-box;background:white;z-index:${zIndex}">${contents}</div>`;

test('stacked ARIA portal modals permit the painted upper form and exclude lower duplicates', async (t) => {
  const page = await pageFor(
    t,
    portalModal('lower', cardHtml(), 10) + portalModal('upper', cardHtml(), 20)
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.equal(
    await page.locator('#upper input[autocomplete="cc-number"]').inputValue(),
    card.number
  );
  assert.deepEqual(
    await page.locator('#lower input').evaluateAll((nodes) => nodes.map((node) => node.value)),
    ['', '', '']
  );
  assert.deepEqual(await verifyCard(page, card), []);
  assert.equal((await actions(page)).click, 0);
});

test('a lower ARIA portal form stays blocked by the painted upper verification modal', async (t) => {
  const page = await pageFor(
    t,
    portalModal('lower', cardHtml(), 10) + portalModal('upper', 'Synthetic verification', 20)
  );
  await assertBlocked(page);
});

test('disjoint visible ARIA modals fail closed when no painted stacking order is provable', async (t) => {
  const page = await pageFor(
    t,
    `<div role="dialog" aria-modal="true" style="position:fixed;left:8px;top:80px;width:700px;height:150px;background:white">${cardHtml()}</div>` +
      '<div role="dialog" aria-modal="true" style="position:fixed;right:8px;top:80px;width:180px;height:150px;background:white">Synthetic verification</div>'
  );
  await assertBlocked(page);
});

for (const kind of ['native', 'aria']) {
  test(`stacked ${kind} modals inside the same open shadow root retain upper ownership`, async (t) => {
    const page = await pageFor(t, '<div id="host"></div>');
    const html =
      kind === 'native'
        ? `<dialog id="lower">${cardHtml()}</dialog><dialog id="upper">${cardHtml()}</dialog>`
        : portalModal('lower', cardHtml(), 10) + portalModal('upper', cardHtml(), 20);
    await page.evaluate(
      ({ html, kind }) => {
        const shadow = document.querySelector('#host').attachShadow({ mode: 'open' });
        shadow.innerHTML = html;
        if (kind === 'native') {
          shadow.querySelector('#lower').showModal();
          shadow.querySelector('#upper').showModal();
        }
        for (const key of Object.keys(window.syntheticActions)) window.syntheticActions[key] = 0;
      },
      { html, kind }
    );
    assert.equal((await inspectCardReadiness(page)).ready, true);
    await assertNoActions(page);
    assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
    assert.equal(
      await page.locator('#upper input[autocomplete="cc-number"]').inputValue(),
      card.number
    );
    assert.deepEqual(
      await page.locator('#lower input').evaluateAll((nodes) => nodes.map((node) => node.value)),
      ['', '', '']
    );
    assert.deepEqual(await verifyCard(page, card), []);
    assert.equal((await actions(page)).click, 0);
  });
}

for (const kind of ['aria', 'native']) {
  test(`${kind} modal in an ancestor document blocks a nested iframe background`, async (t) => {
    const dialog = kind === 'aria' ? modal() : '<dialog>Synthetic verification</dialog>';
    const page = await pageFor(t, iframe(iframe(cardHtml())) + dialog);
    if (kind === 'native') {
      await page.locator('dialog').evaluate((node) => node.showModal());
      await page.evaluate(() => {
        for (const key of Object.keys(window.syntheticActions)) window.syntheticActions[key] = 0;
      });
    }
    await assertBlocked(page);
  });
}

test('an iframe inside the displayed modal stays eligible across its parent document', async (t) => {
  const page = await pageFor(t, cardHtml() + modal(iframe(cardHtml())));
  assert.equal((await inspectCardReadiness(page)).ready, true);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3500 })).ok, true);
  assert.equal(await page.locator('body > input[autocomplete="cc-number"]').inputValue(), '');
  assert.deepEqual(await verifyCard(page, card), []);
});

test('hidden ARIA modals and a nonmodal open dialog do not block the form', async (t) => {
  const page = await pageFor(
    t,
    cardHtml() +
      '<div role="dialog" aria-modal="true" hidden>Synthetic verification</div>' +
      '<dialog open style="position:fixed;right:0;bottom:0;left:auto;top:auto">Synthetic notice</dialog>'
  );
  assert.equal((await inspectCardReadiness(page)).ready, true);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
});

for (const [name, attributes] of [
  ['clip-path copy', 'style="clip-path:inset(50%)"'],
  [
    'screen reader copy',
    'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"'
  ],
  ['negative-coordinate copy', 'style="position:absolute;left:-10000px;top:0"']
]) {
  test(`an unreachable ${name} is never accepted or filled`, async (t) => {
    const page = await pageFor(t, cardHtml(attributes));
    await assertBlocked(page);
  });
}

test('a below-fold form can be scrolled into view without pointer or focus events', async (t) => {
  const page = await pageFor(t, '<div style="height:1800px"></div>' + cardHtml());
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.equal((await inspectCardReadiness(page, { deadline: Date.now() + 2200 })).ready, true);
  assert.ok((await page.evaluate(() => window.scrollY)) > 0);
  await assertNoActions(page);
  assert.equal((await fillCard(page, card, { deadline: Date.now() + 3000 })).ok, true);
  assert.deepEqual(await verifyCard(page, card), []);
  assert.equal((await actions(page)).click, 0);
});

test('two physically visible ARIA card numbers remain ambiguous regardless of score', async (t) => {
  const page = await pageFor(
    t,
    cardHtml() + '<input aria-hidden="true" placeholder="1234 1234 1234 1234">'
  );
  const readiness = await inspectCardReadiness(page, { deadline: Date.now() + 1500 });
  assert.equal(readiness.ready, false);
  const result = await fillCard(page, card, { deadline: Date.now() + 900 });
  assert.equal(result.ok, false);
  assert.deepEqual(
    await page.locator('input').evaluateAll((nodes) => nodes.map((node) => node.value)),
    ['', '', '', '']
  );
  await assertNoActions(page);
});

for (const mutation of ['duplicate', 'modal']) {
  test(`a ${mutation} introduced by scrolling is checked before readiness or filling`, async (t) => {
    const page = await pageFor(t, '<div style="height:1800px"></div>' + cardHtml());
    await page.evaluate((kind) => {
      window.addEventListener(
        'scroll',
        () => {
          window.mutationDone = true;
          if (kind === 'duplicate') {
            const copy = document.createElement('input');
            copy.autocomplete = 'cc-number';
            copy.setAttribute('aria-hidden', 'true');
            document.body.append(copy);
          } else {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.style.cssText = 'position:fixed;right:0;bottom:0;background:white';
            dialog.textContent = 'Synthetic verification';
            document.body.append(dialog);
          }
        },
        { once: true }
      );
    }, mutation);
    const readiness = await inspectCardReadiness(page, { deadline: Date.now() + 2000 });
    assert.equal(readiness.ready, false);
    assert.equal(await page.evaluate(() => window.mutationDone), true);
    const result = await fillCard(page, card, { deadline: Date.now() + 800 });
    assert.equal(result.ok, false);
    await assertEmptyNumbers(page);
    await assertNoActions(page);
  });
}

test('a control replaced during scrolling is rediscovered or rejected without touching the old node', async (t) => {
  const page = await pageFor(t, '<div style="height:1800px"></div>' + cardHtml());
  await page.evaluate(() => {
    window.addEventListener(
      'scroll',
      () => {
        window.mutationDone = true;
        const previous = document.querySelector('[autocomplete="cc-number"]');
        window.syntheticOldControl = previous;
        const replacement = previous.cloneNode();
        replacement.setAttribute('data-replacement', 'true');
        previous.replaceWith(replacement);
      },
      { once: true }
    );
  });
  await inspectCardReadiness(page, { deadline: Date.now() + 2000 });
  assert.equal(await page.evaluate(() => window.mutationDone), true);
  await assertNoActions(page);
  const result = await fillCard(page, card, { deadline: Date.now() + 3000 });
  assert.equal(await page.evaluate(() => window.syntheticOldControl.value), '');
  if (result.ok) {
    assert.equal(await page.locator('[data-replacement]').inputValue(), card.number);
    assert.deepEqual(await verifyCard(page, card), []);
  } else {
    await assertEmptyNumbers(page);
  }
  assert.equal((await actions(page)).click, 0);
});

for (const [name, style] of [
  ['ordinary', ''],
  ['translated', 'transform:translate(10px,10px);'],
  ['rotated', 'transform:rotate(5deg);']
]) {
  test(`${name} iframe covered by a parent button is rejected without a real click`, async (t) => {
    const page = await pageFor(
      t,
      iframe(cardHtml(), '', style) +
        '<button style="position:fixed;inset:0;z-index:9999" onclick="window.syntheticButtonClicks=(window.syntheticButtonClicks||0)+1">Synthetic verification</button>'
    );
    await assertBlocked(page);
    assert.equal(await page.evaluate(() => window.syntheticButtonClicks || 0), 0);
  });
}

for (const wrapper of [
  (html) => html + modal(),
  (html) =>
    iframe(html, '', 'transform:translate(10px,10px);') +
    '<button style="position:fixed;inset:0;z-index:9999" onclick="window.syntheticButtonClicks=(window.syntheticButtonClicks||0)+1">Synthetic verification</button>'
]) {
  test('final readback rejects matching values behind a modal or iframe overlay', async (t) => {
    const page = await pageFor(t, wrapper(cardHtml('', true)));
    await assertNotVerified(page);
    await assertNoActions(page);
    assert.equal(await page.evaluate(() => window.syntheticButtonClicks || 0), 0);
  });
}

for (const mode of ['cancelled before start', 'cancelled while waiting', 'deadline elapsed']) {
  test(`${mode} cannot cause late scroll, focus, pointer or write actions`, async (t) => {
    const page = await pageFor(
      t,
      cardHtml() +
        '<button style="position:fixed;inset:0;z-index:9999" onclick="window.syntheticButtonClicks=(window.syntheticButtonClicks||0)+1">Synthetic verification</button>'
    );
    const controller = new AbortController();
    let timer;
    if (mode === 'cancelled before start') controller.abort();
    if (mode === 'cancelled while waiting') timer = setTimeout(() => controller.abort(), 25);
    t.after(() => clearTimeout(timer));
    const deadline = mode === 'deadline elapsed' ? Date.now() - 1 : Date.now() + 1800;
    const result = await fillCard(page, card, { deadline, signal: controller.signal });
    assert.equal(result.ok, false);
    const before = await actions(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(400);
    assert.deepEqual(await actions(page), before);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
    await assertEmptyNumbers(page);
    await assertNoActions(page);
    assert.equal(await page.evaluate(() => window.syntheticButtonClicks || 0), 0);
  });
}
