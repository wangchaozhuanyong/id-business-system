'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('../upstream/node_modules/playwright');
const { fillCard, fillBilling } = require('../checkout-form.cjs');
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
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(html);
  return page;
}
const iframe = (html) =>
  `<iframe style="width:900px;height:600px" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;

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
