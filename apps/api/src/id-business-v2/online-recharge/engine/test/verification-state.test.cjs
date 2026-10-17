'use strict';
/* global document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');
const { inflateSync } = require('node:zlib');
const { chromium } = require('../upstream/node_modules/playwright');
const runtime = require('../upstream/verification-runtime');
const solver = require('../upstream/hcaptcha-solver');
const platform = require('../upstream/captcha-platform');
const humanSource = fs.readFileSync(
  path.join(__dirname, '../upstream/human-verification.js'),
  'utf8'
);
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

function human(
  stub = async () => ({ ok: false, code: 'VERIFICATION_SOLVER_DISABLED' }),
  headful = '0'
) {
  const module = { exports: {} };
  runInNewContext(humanSource, {
    module,
    console: { log() {} },
    process: { env: { HEADFUL: headful } },
    require(name) {
      if (name === './hcaptcha-solver')
        return { solveHcaptchaOnPage: stub, isHcaptchaSolverEnabled: () => true };
      if (name === './captcha-platform')
        return { ...platform, isCaptchaPlatformEnabled: () => false };
      if (name === './verification-runtime') return runtime;
      if (name === './auth-page-detect') return require('../upstream/auth-page-detect');
      throw Error(name);
    },
    URL,
    Date,
    Math
  });
  return module.exports;
}

const checkboxUrl =
  'https://newassets.hcaptcha.com/captcha/v1/synthetic/static/hcaptcha.html?kind=checkbox#frame=checkbox';
const challengeUrl =
  'https://newassets.hcaptcha.com/captcha/v1/synthetic/static/hcaptcha.html?kind=challenge#frame=challenge';
const checkboxHtml =
  '<div id="checkbox" role="checkbox" aria-checked="false" tabindex="0" style="width:150px;height:40px" onclick="this.setAttribute(\'aria-checked\',\'true\');parent.postMessage(\'synthetic-verified\',\'*\')">I am human</div>';
const challengeHtml =
  '<h2 id="prompt-question">Please select all squares</h2><canvas width="180" height="180"></canvas>';
async function fixture(t, { image = false, hiddenChallenge = false, duplicate = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'newassets.hcaptcha.com')
      return route.fulfill({
        contentType: 'text/html',
        body: url.searchParams.get('kind') === 'checkbox' ? checkboxHtml : challengeHtml
      });
    if (url.hostname !== 'chatgpt.com') return route.abort();
    const frames = image
      ? `<iframe src="${challengeUrl}" style="width:300px;height:300px"></iframe>`
      : `<iframe id="cb" src="${checkboxUrl}" style="width:300px;height:100px"></iframe>`;
    return route.fulfill({
      contentType: 'text/html',
      body:
        '<div id="overlay">One more step before you are done. Select the checkbox below.</div><input autocomplete="cc-number">' +
        frames +
        (hiddenChallenge ? `<iframe src="${challengeUrl}" hidden></iframe>` : '') +
        (duplicate
          ? `<iframe src="${image ? challengeUrl : checkboxUrl}" style="width:300px;height:300px"></iframe>`
          : '') +
        '<script>addEventListener("message",e=>{if(e.data==="synthetic-verified"){document.getElementById("cb").hidden=true;document.getElementById("overlay").remove();}})</script>'
    });
  });
  const page = await context.newPage();
  await runtime.prepareVerificationPage(page);
  t.after(() => runtime.disposeVerificationPage(page));
  await page.goto('https://chatgpt.com/checkout/synthetic');
  return page;
}

test('checkbox-only instructions are never image prompts', () => {
  for (const instruction of [
    'Select the checkbox below.',
    'One more step before you are done. Select the checkbox below.',
    'I am human'
  ]) {
    assert.equal(runtime.isCheckboxInstruction(instruction), true);
    assert.equal(runtime.isImagePrompt(instruction), false);
  }
  assert.equal(runtime.isImagePrompt('Please select all squares'), true);
  assert.equal(runtime.isImagePrompt('Please try again. Skip EN'), false);
});

test('hidden challenge placeholder and checkout main-page instructions do not become image tasks', async (t) => {
  const page = await fixture(t, { hiddenChallenge: true });
  const frames = await runtime.inspectCaptchaFrames(page);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'checkbox');
  assert.equal(await human().hasHcaptchaImageChallenge(page), false);
  assert.equal(await human().hasHcaptchaSolverTarget(page), false);
});

for (const hiding of [
  'opacity',
  'ancestor-opacity',
  'aria-hidden',
  'ancestor-aria-hidden',
  'inert',
  'ancestor-inert'
]) {
  test(`a ${hiding} stale iframe is excluded from ready candidates`, async (t) => {
    const page = await fixture(t, { image: true, duplicate: true });
    await page.evaluate((kind) => {
      let stale = document.querySelectorAll('iframe')[1];
      if (kind.startsWith('ancestor-')) {
        const wrapper = document.createElement('div');
        stale.replaceWith(wrapper);
        wrapper.append(stale);
        stale = wrapper;
      }
      if (kind.endsWith('opacity')) stale.style.opacity = '0';
      else if (kind.endsWith('aria-hidden')) stale.setAttribute('aria-hidden', 'true');
      else stale.inert = true;
    }, hiding);
    const candidates = await runtime.inspectCaptchaFrames(page);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'challenge');
    assert.equal(await human().hasHcaptchaImageChallenge(page), true);
  });
}

test('a raster hidden by its own ancestor cannot make an image challenge ready', async (t) => {
  const page = await fixture(t, { image: true });
  const frame = page.frames().find((item) => item.url() === challengeUrl);
  await frame.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.style.opacity = '0';
    const canvas = document.querySelector('canvas');
    canvas.replaceWith(wrapper);
    wrapper.append(canvas);
  });
  assert.equal(await human().hasHcaptchaImageChallenge(page), false);
});

test('a nested challenge is excluded when its outer iframe is hidden', async (t) => {
  const page = await fixture(t, { image: true });
  await page.evaluate((url) => {
    const outer = document.createElement('iframe');
    outer.id = 'hidden-outer';
    outer.style.opacity = '0';
    outer.srcdoc = `<iframe src="${url}" style="width:300px;height:300px"></iframe>`;
    document.body.append(outer);
  }, challengeUrl);
  await page
    .frameLocator('#hidden-outer')
    .frameLocator('iframe')
    .locator('canvas')
    .waitFor({ state: 'attached' });
  assert.equal((await runtime.inspectCaptchaFrames(page)).length, 1);
});

test('one visible checkbox completes normally without starting vision or clicking merchant controls', async (t) => {
  const page = await fixture(t, { hiddenChallenge: true });
  let visionCalls = 0;
  // This is a functional success case with real cross-origin rendering, not a
  // short-deadline test. Timeout/cancellation cases retain their own small limits.
  const result = await human(async () => {
    visionCalls++;
    throw Error('Vision is forbidden for a checkbox');
  }).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 10000 });
  assert.equal(result.cleared, true, JSON.stringify(result));
  assert.equal(visionCalls, 0);
  assert.equal(await page.locator('[autocomplete="cc-number"]').inputValue(), '');
});

test('actual visible raster and meaningful instruction identify the challenge frame', async (t) => {
  const page = await fixture(t, { image: true });
  const frames = await runtime.inspectCaptchaFrames(page);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'challenge');
  assert.equal(await human().hasHcaptchaImageChallenge(page), true);
});

for (const image of [false, true])
  test(`two visible ${image ? 'challenge' : 'checkbox'} frames fail without choosing the first`, async (t) => {
    const page = await fixture(t, { image, duplicate: true });
    let calls = 0;
    const result = await human(async () => {
      calls++;
    }).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 1500 });
    assert.equal(result.code, 'VERIFICATION_FRAME_AMBIGUOUS');
    assert.equal(calls, 0);
  });

test('vision failure retains controlled HTTP classification and no response text', async (t) => {
  const page = await fixture(t, { image: true });
  const result = await human(async () => ({
    ok: false,
    code: 'VLM_AUTH_FAILED',
    diagnostics: { httpStatus: 401 }
  })).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 2000 });
  assert.equal(result.code, 'VLM_AUTH_FAILED');
  assert.equal(result.diagnostics.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(result), /Please select|https?:|Bearer|image\/png/);
});

test('unchanged image challenge does not restart the solver', async (t) => {
  const page = await fixture(t, { image: true });
  let calls = 0;
  const result = await human(async () => {
    calls++;
    return { ok: false, retryable: true, code: 'VLM_INVALID_RESPONSE' };
  }).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 2500 });
  assert.equal(result.code, 'VERIFICATION_CHALLENGE_UNCHANGED');
  assert.equal(calls, 1);
});

test('a successful solver response waits for the same page to settle without solving twice', async (t) => {
  const page = await fixture(t, { image: true });
  let calls = 0;
  const result = await human(async () => {
    calls++;
    setTimeout(
      () =>
        page
          .evaluate(() => {
            document.querySelector('iframe').hidden = true;
            document.getElementById('overlay').remove();
          })
          .catch(() => {}),
      950
    );
    return { ok: true };
  }).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 2500 });
  assert.equal(result.cleared, true);
  assert.equal(calls, 1);
});

test('provider diagnostics and result codes are restricted to the documented fields', async (t) => {
  const page = await fixture(t, { image: true });
  const result = await human(async () => ({
    ok: false,
    code: 'VLM_UNTRUSTED_ARBITRARY',
    diagnostics: {
      httpStatus: 401,
      providerCode: 'invalid_api_key',
      prompt: 'PRIVATE',
      response: 'PRIVATE',
      token: 'PRIVATE'
    }
  })).clearHumanVerification(page, { requireCheckoutReady: false, maxWaitMs: 2000 });
  assert.equal(result.code, 'VERIFICATION_SOLVER_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|ARBITRARY/);
  assert.equal(result.diagnostics.httpStatus, 401);
});

for (const mode of ['0', '1'])
  test(`HEADFUL=${mode} cannot disable the round bound`, async (t) => {
    const page = await fixture(t, { image: true });
    let calls = 0;
    const api = human(async () => {
      const state = runtime.verificationState(page);
      state.challenge = { key: `new-${++calls}` };
      return { ok: false, retryable: true, code: 'VLM_INVALID_RESPONSE' };
    }, mode);
    const result = await api.clearHumanVerification(page, {
      requireCheckoutReady: false,
      maxBypassRounds: 2,
      maxWaitMs: 4000
    });
    assert.equal(result.code, 'VERIFICATION_ROUNDS_EXHAUSTED');
    assert.equal(calls, 2);
  });

function observerPage() {
  const page = new EventEmitter(),
    main = {};
  page.addInitScript = async () => {};
  page.evaluate = async (_, binding) => {
    page.binding = binding;
  };
  page.mainFrame = () => main;
  return page;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('network observer is installed before interaction and clears stale fields for a new challenge', async () => {
  const page = observerPage(),
    state = await runtime.prepareVerificationPage(page);
  const emit = async (key, body) => {
    const request = { url: () => `https://api.hcaptcha.com/getcaptcha/${key}` };
    page.emit('request', request);
    page.emit('response', {
      url: request.url,
      status: () => 200,
      request: () => request,
      json: async () => body
    });
    await tick();
  };
  await emit('one', {
    key: 'one',
    requester_question: { en: 'Please select all squares' },
    request_type: 'image_label_binary',
    tasklist: [1]
  });
  assert.equal(state.challenge.prompt, 'Please select all squares');
  await emit('two', { key: 'two', tasklist: [] });
  assert.equal(state.challenge.prompt, '');
  assert.equal(state.challenge.requestType, '');
  assert.equal(state.challenge.taskCount, 0);
  runtime.disposeVerificationPage(page);
  assert.equal(page.listenerCount('response'), 0);
});

test('late response cannot overwrite a newer request or a new navigation', async () => {
  const page = observerPage(),
    state = await runtime.prepareVerificationPage(page);
  let finishOld;
  const old = { url: () => 'https://api.hcaptcha.com/getcaptcha/old' };
  const fresh = { url: () => 'https://api.hcaptcha.com/getcaptcha/new' };
  page.emit('request', old);
  page.emit('response', {
    url: old.url,
    status: () => 200,
    request: () => old,
    json: () =>
      new Promise((r) => {
        finishOld = r;
      })
  });
  page.emit('request', fresh);
  page.emit('response', {
    url: fresh.url,
    status: () => 200,
    request: () => fresh,
    json: async () => ({ key: 'new' })
  });
  await tick();
  const key = state.challenge.key;
  finishOld({ key: 'old', requester_question: { en: 'Please select old squares' } });
  await tick();
  assert.equal(state.challenge.key, key);
  page.emit('framenavigated', page.mainFrame());
  assert.equal(state.challenge, null);
  runtime.disposeVerificationPage(page);
});

test('a late checkcaptcha response cannot verify a newer challenge version', async () => {
  const page = observerPage(),
    state = await runtime.prepareVerificationPage(page);
  const get = async (key) => {
    const request = { url: () => `https://api.hcaptcha.com/getcaptcha/${key}` };
    page.emit('request', request);
    page.emit('response', {
      url: request.url,
      status: () => 200,
      request: () => request,
      json: async () => ({ key })
    });
    await tick();
  };
  await get('first');
  const check = { url: () => 'https://api.hcaptcha.com/checkcaptcha/first' };
  page.emit('request', check);
  await get('second');
  page.emit('response', {
    url: check.url,
    status: () => 200,
    request: () => check,
    json: async () => ({ pass: true })
  });
  await tick();
  assert.equal(state.passed, false);
  runtime.disposeVerificationPage(page);
});

test('overall deadline also bounds a request that ignores AbortSignal', async () => {
  const budget = runtime.createVerificationBudget({ maxWaitMs: 30 });
  const start = Date.now();
  await assert.rejects(budget.run(new Promise(() => {})), { code: 'VERIFICATION_TIMEOUT' });
  assert.ok(Date.now() - start < 500);
  budget.dispose();
});

test('lease cancellation propagates and does not become a network failure', async () => {
  const controller = new AbortController(),
    budget = runtime.createVerificationBudget({ signal: controller.signal });
  controller.abort(Object.assign(new Error('synthetic lease'), { code: 'LEASE_LOST' }));
  assert.throws(() => budget.assert(), { code: 'LEASE_LOST' });
  budget.dispose();
});

test('generic post-verification continue helper never clicks any merchant button', async () => {
  const page = {
    getByRole() {
      throw Error('Forbidden merchant selector');
    },
    locator() {
      throw Error('Forbidden merchant selector');
    }
  };
  assert.equal(await platform.clickCheckoutContinueAfterCaptcha(page), false);
});

test('model payload defaults and single supported parameter adaptation are explicit', () => {
  const gpt = solver.buildVlmPayload('gpt-5.5', [], 1024);
  assert.equal(gpt.max_completion_tokens, 1024);
  assert.equal(gpt.temperature, undefined);
  assert.equal(gpt.max_tokens, undefined);
  const legacy = solver.buildVlmPayload('gpt-4o', [], 1024);
  assert.equal(legacy.max_tokens, 1024);
  assert.equal(
    solver.adaptVlmParameter(legacy, { code: 'unsupported_parameter', param: 'max_tokens' }),
    true
  );
  assert.equal(legacy.max_completion_tokens, 1024);
  assert.equal(
    solver.adaptVlmParameter(legacy, { code: 'invalid_api_key', param: 'temperature' }),
    false
  );
});

function probeColour(payload) {
  const image = payload.messages[0].content.find((item) => item.type === 'image_url');
  assert.ok(image?.image_url?.url.startsWith('data:image/png;base64,'));
  const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
  let offset = 8,
    data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset),
      kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data)),
    pixel = [...raw.subarray(24 * 145 + 1 + 24 * 3, 24 * 145 + 1 + 24 * 3 + 3)];
  return pixel[0] > pixel[1] && pixel[0] > pixel[2]
    ? 'red'
    : pixel[2] > pixel[1]
      ? 'blue'
      : 'green';
}

test('vision health requires image understanding and valid JSON, not HTTP 200 text ping', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  global.fetch = async (_, options) => {
    const payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { content: JSON.stringify({ colour: probeColour(payload), shape: 'square' }) }
          }
        ]
      })
    };
  };
  const passed = await solver.testVlmConnectivity({
    vlm_api_key: 'synthetic-key',
    vlm_model: 'gpt-5.5'
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.image_json_verified, true);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] })
  });
  assert.equal(
    (await solver.testVlmConnectivity({ vlm_api_key: 'synthetic-key' })).code,
    'VLM_VISION_CHECK_FAILED'
  );
});

for (const [status, code] of [
  [401, 'VLM_AUTH_FAILED'],
  [429, 'VLM_RATE_LIMITED'],
  [503, 'VLM_PROVIDER_UNAVAILABLE']
])
  test(`vision health preserves HTTP ${status} without logging the response`, async (t) => {
    const original = global.fetch;
    t.after(() => {
      global.fetch = original;
    });
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: false,
        status,
        json: async () => ({
          error: { code: 'synthetic_failure', message: 'PRIVATE_SYNTHETIC_BODY' }
        })
      };
    };
    const result = await solver.testVlmConnectivity({ vlm_api_key: 'synthetic-key' });
    assert.equal(result.code, code);
    assert.equal(result.http_status, status);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_BODY|synthetic-key/);
  });

test('vision parameter adaptation has at most one retry and no model or endpoint switch', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return {
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 'unsupported_parameter',
          param: calls.length === 1 ? 'temperature' : 'max_tokens'
        }
      })
    };
  };
  const result = await solver.testVlmConnectivity({
    vlm_api_key: 'synthetic-key',
    vlm_model: 'gpt-4o'
  });
  assert.equal(result.code, 'VLM_REQUEST_UNSUPPORTED');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.temperature, undefined);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].payload.model, calls[1].payload.model);
});
