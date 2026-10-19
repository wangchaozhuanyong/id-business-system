'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('../upstream/node_modules/playwright');
const human = require('../upstream/human-verification');
const auth = require('../upstream/auth-page-detect');

// The real DOM detectors run in Chromium; no official or business transport exists.
const chat =
  '<button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea>';
const quotation =
  'Earlier instructions said: Verify you are human. Cloudflare security check. ' +
  'Just a moment. Please select the checkbox below. 人机验证，请勾选。';
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']
  });
});

test.after(async () => browser?.close());

async function pageFixture(t, markup) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let networkRequests = 0;
  await context.route('**/*', async (route) => {
    networkRequests++;
    await route.abort();
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    assert.equal(networkRequests, 0, 'DOM-only login evidence must not issue network requests');
  });
  await page.setContent(`<!doctype html><html><body>${markup}</body></html>`);
  return page;
}

for (const [label, content] of [
  [
    'conversation-turn quotation',
    `<section data-testid="conversation-turn-1"><p>${quotation}</p></section>`
  ],
  ['message-author quotation', `<div data-message-author-role="user"><p>${quotation}</p></div>`],
  [
    'editable composer quotation',
    `<form data-testid="composer"><div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Ask ChatGPT">${quotation}</div></form>`
  ],
  [
    'textarea composer quotation',
    `<form data-testid="composer"><textarea aria-label="Ask ChatGPT">${quotation}</textarea></form>`
  ]
]) {
  test(`ordinary authenticated ${label} is not verification evidence`, async (t) => {
    const page = await pageFixture(t, `<main>${chat}${content}</main>`);
    assert.equal(await auth.hasLoggedInChatUi(page), true);
    assert.equal(await human.isBlockingHumanVerificationVisible(page), false);
    assert.equal(await human.isCloudflareWallPage(page), false);
    assert.equal(await human.isVerificationCleared(page, { requireCheckoutReady: false }), true);
  });
}

for (const [label, markup] of [
  [
    'page verification instruction',
    '<main><h1>Verify you are human</h1><p>Cloudflare security check</p></main>'
  ],
  [
    'verification dialog over authenticated chat',
    `<main>${chat}</main><section role="dialog" aria-modal="true"><h2>Verify you are human</h2><p>Cloudflare security check</p></section>`
  ],
  [
    'interactive verification group',
    `<main>${chat}</main><section id="challenge-stage"><p>Select the checkbox below</p><input type="checkbox" aria-label="I am human"></section>`
  ]
]) {
  test(`actual ${label} remains blocking`, async (t) => {
    const page = await pageFixture(t, markup);
    assert.equal(await human.isBlockingHumanVerificationVisible(page), true);
    assert.equal(await human.isVerificationCleared(page, { requireCheckoutReady: false }), false);
  });
}

for (const [label, attributes] of [
  ['hidden', 'hidden'],
  ['display-none', 'style="display:none"'],
  ['transparent', 'style="opacity:0"'],
  ['aria-hidden', 'aria-hidden="true"']
]) {
  test(`${label} verification residue is not a blocking login wall`, async (t) => {
    const page = await pageFixture(
      t,
      `<main>${chat}</main><section ${attributes}><h1>${quotation}</h1><iframe title="Cloudflare" style="width:300px;height:90px"></iframe></section>`
    );
    assert.equal(await auth.hasLoggedInChatUi(page), true);
    assert.equal(await human.isBlockingHumanVerificationVisible(page), false);
    assert.equal(await human.isCloudflareWallPage(page), false);
    assert.equal(await human.isVerificationCleared(page, { requireCheckoutReady: false }), true);
  });
}
