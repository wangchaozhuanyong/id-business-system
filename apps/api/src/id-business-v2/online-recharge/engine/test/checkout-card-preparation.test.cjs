'use strict';
/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const { prepareCheckoutCardSection } = require('../upstream/stripe-payment');
const { isCheckoutPaymentReady } = require('../upstream/human-verification');

const origin = 'https://card-preparation.invalid';
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

function label(id, attributes = '') {
  return `<div style="height:1800px"></div><p id="${id}" ${attributes}>Card number</p>`;
}

async function fixture(t, labels, { mount = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 600 },
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const requests = { documents: 0, payments: 0, unexpected: 0 };
  t.after(async () => {
    await context.close();
    assert.deepEqual(requests, { documents: 1, payments: 0, unexpected: 0 });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      requests.payments++;
      return route.abort('blockedbyclient');
    }
    if (request.method() !== 'GET' || request.url() !== origin + '/') {
      requests.unexpected++;
      return route.abort('blockedbyclient');
    }
    requests.documents++;
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1>Synthetic checkout</h1>
        ${labels}<div style="height:1000px"></div>
        <form action="/payment" method="post"><button>Subscribe</button></form>
        <script>
          window.mounts=[];
          window.clicks=0;
          document.addEventListener('click',()=>window.clicks++);
          const observer=new IntersectionObserver(entries=>{
            for(const entry of entries){
              if(!entry.isIntersecting || !${JSON.stringify(mount)}) continue;
              window.mounts.push(entry.target.id);
              entry.target.insertAdjacentHTML('afterend','<input autocomplete="cc-number">');
              observer.unobserve(entry.target);
            }
          });
          document.querySelectorAll('p').forEach(element=>observer.observe(element));
          window.observerInstalled=true;
        </script></body></html>`
    });
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.observerInstalled);
  return page;
}

async function state(page) {
  return page.evaluate(() => ({
    scrollY: window.scrollY,
    mounts: window.mounts,
    clicks: window.clicks
  }));
}

test('a unique physically rendered ARIA-hidden card label can mount lazy fields by scrolling', async (t) => {
  const page = await fixture(t, label('physical-label', 'aria-hidden="true"'));
  assert.equal(await isCheckoutPaymentReady(page), false);
  await prepareCheckoutCardSection(page);
  await page.waitForFunction(() => window.mounts.length === 1);
  assert.deepEqual((await state(page)).mounts, ['physical-label']);
  assert.equal((await state(page)).clicks, 0);
  assert.equal(await isCheckoutPaymentReady(page), true);
});

test('an accessible card label takes precedence over a physically rendered ARIA-hidden decoy', async (t) => {
  const page = await fixture(
    t,
    label('aria-decoy', 'aria-hidden="true"') + label('accessible-label')
  );
  await prepareCheckoutCardSection(page);
  await page.waitForFunction(() => window.mounts.length === 1);
  assert.deepEqual((await state(page)).mounts, ['accessible-label']);
  assert.equal((await state(page)).clicks, 0);
  assert.equal(await isCheckoutPaymentReady(page), true);
});

for (const attributes of ['', 'aria-hidden="true"']) {
  test(`multiple ${attributes ? 'physical' : 'accessible'} card labels remain ambiguous and do not scroll`, async (t) => {
    const page = await fixture(t, label('first', attributes) + label('second', attributes));
    await prepareCheckoutCardSection(page);
    assert.deepEqual(await state(page), { scrollY: 0, mounts: [], clicks: 0 });
    assert.equal(await isCheckoutPaymentReady(page), false);
  });
}

for (const attributes of [
  'hidden',
  'style="display:none"',
  'style="visibility:hidden"',
  'style="opacity:0"',
  'inert',
  'style="width:0;height:0;overflow:hidden"'
]) {
  test(`a noninteractive card label (${attributes}) cannot trigger the fallback`, async (t) => {
    const page = await fixture(t, label('excluded-label', attributes));
    await prepareCheckoutCardSection(page);
    assert.deepEqual(await state(page), { scrollY: 0, mounts: [], clicks: 0 });
    assert.equal(await isCheckoutPaymentReady(page), false);
  });
}

test('scrolling an eligible card label does not establish actual card readiness', async (t) => {
  const page = await fixture(t, label('label-only', 'aria-hidden="true"'), { mount: false });
  await prepareCheckoutCardSection(page);
  assert.ok((await state(page)).scrollY > 0);
  assert.deepEqual((await state(page)).mounts, []);
  assert.equal((await state(page)).clicks, 0);
  assert.equal(await isCheckoutPaymentReady(page), false);
});

test('cancellation stops preparation before scrolling or lazy mounting', async (t) => {
  const page = await fixture(t, label('cancelled-label', 'aria-hidden="true"'));
  const controller = new AbortController();
  const reason = Object.assign(new Error('Synthetic lease lost'), { code: 'LEASE_LOST' });
  controller.abort(reason);
  await assert.rejects(
    prepareCheckoutCardSection(page, { signal: controller.signal }),
    (error) => error === reason
  );
  assert.deepEqual(await state(page), { scrollY: 0, mounts: [], clicks: 0 });
});

test('an expired shared deadline cannot be replaced by the optional preparation budget', async (t) => {
  const page = await fixture(t, label('expired-label', 'aria-hidden="true"'));
  await assert.rejects(prepareCheckoutCardSection(page, { deadlineAt: performance.now() - 1 }), {
    code: 'VERIFICATION_TIMEOUT'
  });
  assert.deepEqual(await state(page), { scrollY: 0, mounts: [], clicks: 0 });
});
