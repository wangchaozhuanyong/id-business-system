#!/usr/bin/env node
'use strict';
/* global __dirname, console, document, localStorage, module, process, require, window */
/* eslint-disable @typescript-eslint/no-require-imports -- This CommonJS verification entry also supports compilation from stdin. */

// Standalone, credential-free browser comparison. No application/DB is started.
// Run directly, or compile stdin with Module._compile and call exports.run().
// Container stdin: ENGINE_ROOT=/workspace/engine PARITY_OUTPUT_ROOT=/tmp/parity
//   PARITY_AUTORUN=1 node - < online-checkout-actionability-parity.cjs
// PARITY_HEADFUL=1 uses the caller's Xvfb/display. Nothing enables real network.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createRequire } = require('node:module');

const FIXTURE_ORIGIN = 'https://launcher-parity.invalid';
const FIXTURE_DOCUMENT = FIXTURE_ORIGIN + '/synthetic-document';
const CARD = Object.freeze({ number: '4242424242424242', expiry: '12/30', cvc: '123' });
const FIELDS =
  '<input data-field="number" autocomplete="cc-number">' +
  '<input data-field="expiry" autocomplete="cc-exp">' +
  '<input data-field="cvc" autocomplete="cc-csc">';
const CONTEXT = Object.freeze({
  viewport: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  locale: 'en-PH',
  timezoneId: 'Asia/Manila',
  serviceWorkers: 'block'
});
const CODES = new Set([
  'CHECKOUT_CARD_READY',
  'CHECKOUT_CARD_NOT_READY',
  'CHECKOUT_CONTROL_AMBIGUOUS',
  'CHECKOUT_PAGE_CLOSED',
  'CHECKOUT_FORM_ABORTED',
  'CHECKOUT_FORM_TIMEOUT',
  'CHECKOUT_CONTROL_READ_FAILED',
  'CHECKOUT_CONTROL_BLOCKED',
  'CHECKOUT_FORM_DATA_MISSING',
  'CHECKOUT_CONTENT_LOAD_FAILED'
]);
const REASONS = [
  'hidden',
  'inert',
  'aria_hidden',
  'aria_disabled',
  'display_none',
  'opacity_zero',
  'content_visibility_hidden',
  'visibility_hidden',
  'zero_geometry',
  'disabled',
  'readonly',
  'excluded_type',
  'no_locator',
  'modal_background'
];

function fixedError(code) {
  return Object.assign(new Error(code), { parityCode: code });
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function version(value) {
  return /^\d+(?:\.\d+){0,4}$/.test(String(value)) ? String(value) : 'UNAVAILABLE';
}
function code(value) {
  return CODES.has(value) ? value : 'UNAVAILABLE';
}
function counts(value) {
  return Object.fromEntries(
    REASONS.filter((key) => count(value?.[key])).map((key) => [key, count(value[key])])
  );
}
function snapshot(result) {
  const inspection = result?.inspection || {};
  return {
    ready: result?.ready === true,
    code: code(result?.code),
    scanned: count(inspection.controlCounts?.scanned),
    eligible: count(inspection.controlCounts?.eligible),
    locatable: count(inspection.controlCounts?.locatable),
    recognized: count(inspection.controlCounts?.recognized),
    framesChecked: count(inspection.framesChecked),
    framesSkipped: count(inspection.framesSkipped),
    frameRejects: counts(inspection.frameSkipCounts),
    controlRejects: counts(inspection.controlRejectCounts),
    complete: inspection.complete === true,
    timedOut: inspection.timedOut === true
  };
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}
function paths() {
  const defaultEngine = path.resolve(
    __dirname,
    '../../apps/api/src/id-business-v2/online-recharge/engine'
  );
  const engine = process.env.ENGINE_ROOT || defaultEngine;
  if (!path.isAbsolute(engine)) throw fixedError('ENGINE_ROOT_NOT_ABSOLUTE');
  if (!fs.existsSync(path.join(engine, 'checkout-form.cjs')))
    throw fixedError('ENGINE_ROOT_INVALID');
  // Every caller explicitly owns its absolute transient output location.
  const output = process.env.PARITY_OUTPUT_ROOT;
  if (!output) throw fixedError('OUTPUT_ROOT_REQUIRED');
  if (!path.isAbsolute(output)) throw fixedError('OUTPUT_ROOT_NOT_ABSOLUTE');
  const normalized = path.resolve(output);
  // An explicitly supplied absolute runtime belongs to the caller; this also
  // supports a writable container /tmp without deriving output from its cwd.
  if (normalized === path.parse(normalized).root)
    throw fixedError('OUTPUT_ROOT_OUTSIDE_ALLOWED_RUNTIME');
  return { engine: path.resolve(engine), output: normalized };
}
async function newContext(browser, traffic) {
  const context = await browser.newContext(CONTEXT);
  await context.route('**/*', async (route) => {
    // The one synthetic document is served in memory, without a server or DNS.
    // It supplies a non-opaque origin solely for real localStorage isolation.
    // Every other HTTP request is aborted; no official endpoint is whitelisted.
    if (route.request().method() === 'GET' && route.request().url() === FIXTURE_DOCUMENT) {
      traffic.syntheticDocuments++;
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Fixture</title>'
      });
    }
    traffic.blockedHttp++;
    return route.abort('blockedbyclient');
  });
  if (context.routeWebSocket)
    await context.routeWebSocket('**/*', (socket) => {
      traffic.blockedWebSocket++;
      socket.close();
    });
  context.setDefaultTimeout(2500);
  return context;
}
async function valueCounts(page) {
  return page.locator('input').evaluateAll(
    (nodes, expected) => ({
      filled: nodes.filter((node) => node.value !== '').length,
      matching: nodes.filter((node) => node.value === expected[node.dataset.field]).length,
      helpersFilled: nodes.filter((node) => node.hasAttribute('data-helper') && node.value !== '')
        .length
    }),
    CARD
  );
}
async function runCase(browser, form, definition, traffic) {
  const context = await newContext(browser, traffic);
  try {
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><body>' + definition.html + '</body>'
    );
    if (definition.modal) await page.locator('dialog').evaluate((dialog) => dialog.showModal());
    const before = snapshot(await form.inspectCardReadiness(page, { deadline: Date.now() + 2500 }));
    if (definition.release)
      await page.evaluate(() => {
        window.setTimeout(() => {
          const region = document.querySelector('[data-lifecycle]');
          region.removeAttribute('aria-hidden');
          region.style.visibility = 'visible';
        }, 180);
      });
    const fill = await form.fillCard(page, CARD, {
      deadline: Date.now() + (definition.allow ? 5000 : 900)
    });
    const after = snapshot(await form.inspectCardReadiness(page, { deadline: Date.now() + 2500 }));
    const values = await valueCounts(page);
    const readyExpected = definition.release ? false : definition.allow;
    let passed =
      before.ready === readyExpected &&
      fill.ok === definition.allow &&
      after.ready === definition.allow &&
      values.helpersFilled === 0;
    if (definition.allow) passed &&= values.filled === 3 && values.matching === 3;
    else passed &&= values.filled === 0;
    if (definition.ambiguous)
      passed &&=
        before.code === 'CHECKOUT_CONTROL_AMBIGUOUS' &&
        fill.errorCode === 'CHECKOUT_CONTROL_AMBIGUOUS';
    if (definition.zero)
      passed &&=
        before.frameRejects.zero_geometry === 1 &&
        before.controlRejects.zero_geometry === 1 &&
        before.eligible === 3;
    return {
      case: definition.name,
      status: passed ? 'PASS' : 'FAIL',
      before,
      after,
      fillOk: fill.ok === true,
      fillCode: fill.ok ? 'FILLED' : code(fill.errorCode),
      ...values
    };
  } finally {
    await context.close();
  }
}
async function poolIsolation(browser, traffic) {
  const first = await newContext(browser, traffic);
  let second;
  try {
    const a = await first.newPage();
    await a.goto(FIXTURE_DOCUMENT);
    await a.evaluate(() => {
      document.cookie = 'parity_cookie=synthetic; Secure; SameSite=Strict; path=/';
      localStorage.setItem('parity_storage', 'synthetic');
    });
    second = await newContext(browser, traffic);
    const b = await second.newPage();
    await b.goto(FIXTURE_DOCUMENT);
    const inspect = (page) =>
      page.evaluate(() => ({
        cookies: document.cookie
          .split(';')
          .filter((item) => item.trim() === 'parity_cookie=synthetic').length,
        storage: localStorage.getItem('parity_storage') === 'synthetic' ? 1 : 0
      }));
    const firstBefore = await inspect(a),
      secondBefore = await inspect(b);
    await b.evaluate(() => {
      document.cookie = 'parity_cookie=second; Secure; SameSite=Strict; path=/';
      localStorage.setItem('parity_storage', 'second');
    });
    const firstAfter = await inspect(a);
    await first.close();
    const secondRetained = await b.evaluate(
      () =>
        document.cookie.includes('parity_cookie=second') &&
        localStorage.getItem('parity_storage') === 'second'
    );
    const passed =
      firstBefore.cookies === 1 &&
      firstBefore.storage === 1 &&
      secondBefore.cookies === 0 &&
      secondBefore.storage === 0 &&
      firstAfter.cookies === 1 &&
      firstAfter.storage === 1 &&
      secondRetained;
    return {
      case: 'POOL_CONTEXT_ISOLATION',
      status: passed ? 'PASS' : 'FAIL',
      firstCookieCount: firstBefore.cookies,
      firstStorageCount: firstBefore.storage,
      secondInitialCookieCount: secondBefore.cookies,
      secondInitialStorageCount: secondBefore.storage,
      firstStoragePreserved: firstAfter.storage === 1,
      secondRetainedAfterFirstClose: secondRetained
    };
  } finally {
    await first.close().catch(() => {});
    if (second) await second.close();
  }
}
const DEFINITIONS = [
  { name: 'ORDINARY_FIELDS', allow: true, html: FIELDS },
  {
    name: 'ARIA_VISIBLE_INTERACTIVE',
    allow: true,
    html: '<section aria-hidden="true">' + FIELDS + '</section>'
  },
  {
    name: 'ARIA_HIDDEN_LIFECYCLE_RELEASED',
    allow: true,
    release: true,
    html:
      '<section data-lifecycle aria-hidden="true" style="visibility:hidden">' +
      FIELDS +
      '</section>'
  },
  {
    name: 'EXPLICIT_INERT_BACKGROUND_BLOCKED',
    allow: false,
    html:
      '<main inert>' +
      FIELDS +
      '</main><section role="dialog" aria-modal="true">Synthetic modal</section>'
  },
  {
    name: 'NATIVE_MODAL_BACKGROUND_BLOCKED',
    allow: false,
    modal: true,
    html:
      '<main>' + FIELDS + '</main><dialog>Synthetic modal<button>Fixture action</button></dialog>'
  },
  {
    name: 'ZERO_GEOMETRY_HELPERS_EXCLUDED',
    allow: true,
    zero: true,
    html:
      FIELDS +
      '<input data-helper autocomplete="cc-number" style="width:0;height:0;border:0;padding:0">' +
      '<iframe style="width:0;height:0;border:0" srcdoc="&lt;input autocomplete=&quot;cc-number&quot;&gt;"></iframe>'
  },
  {
    name: 'VISIBLE_DUPLICATES_AMBIGUOUS',
    allow: false,
    ambiguous: true,
    html: FIELDS + '<input autocomplete="cc-number">'
  }
];

async function executeMode(mode, configuration, dependencies) {
  const traffic = { syntheticDocuments: 0, blockedHttp: 0, blockedWebSocket: 0 };
  const result = {
    mode,
    status: 'PASS',
    browserVersion: 'UNAVAILABLE',
    cases: [],
    traffic,
    cleanupFailures: 0
  };
  let browser, pool, slot;
  try {
    if (mode === 'NATIVE_PLAYWRIGHT') {
      browser = await dependencies.playwright.chromium.launch({
        headless: !configuration.headful,
        args: [
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
          ...(process.env.RUNNING_IN_DOCKER === '1'
            ? ['--no-sandbox', '--disable-setuid-sandbox']
            : [])
        ]
      });
    } else if (mode === 'FORMAL_STANDALONE') {
      const session = await require(
        path.join(configuration.engine, 'upstream/browser-standalone.js')
      ).connectStandaloneBrowser({
        headful: configuration.headful,
        cdpPort: String(await availablePort())
      });
      browser = session.browser;
    } else {
      process.env.HEADFUL = configuration.headful ? '1' : '0';
      process.env.BROWSER_POOL_BASE_PORT = String(await availablePort());
      pool = require(path.join(configuration.engine, 'upstream/browser-pool.js'));
      pool.setRuntimeEnabled(true);
      pool.setRuntimePoolSize(1);
      pool.setRuntimeProfileRoot(configuration.output);
      const initialized = await pool.initBrowserPool();
      if (!initialized.enabled || initialized.size !== 1) throw fixedError('POOL_LAUNCH_FAILED');
      slot = await pool.acquireSlot('synthetic-launcher-parity');
      if (!slot) throw fixedError('POOL_SLOT_UNAVAILABLE');
      const session = await require(
        path.join(configuration.engine, 'upstream/browser-pool-client.js')
      ).connectPoolBrowser({ poolCdpUrl: slot.cdpUrl, poolSlotId: slot.slotId });
      browser = session.browser;
    }
    result.browserVersion = version(browser.version());
    for (const definition of DEFINITIONS) {
      try {
        result.cases.push(await runCase(browser, dependencies.form, definition, traffic));
      } catch {
        result.cases.push({ case: definition.name, status: 'FAIL', code: 'CASE_EXECUTION_FAILED' });
      }
    }
    if (mode === 'FORMAL_POOL_CDP') {
      try {
        result.cases.push(await poolIsolation(browser, traffic));
      } catch {
        result.cases.push({
          case: 'POOL_CONTEXT_ISOLATION',
          status: 'FAIL',
          code: 'ISOLATION_EXECUTION_FAILED'
        });
      }
    }
    if (result.cases.some((entry) => entry.status !== 'PASS')) result.status = 'FAIL';
  } catch (error) {
    result.status = 'FAIL';
    result.code = ['POOL_LAUNCH_FAILED', 'POOL_SLOT_UNAVAILABLE'].includes(error.parityCode)
      ? error.parityCode
      : browser
        ? 'MODE_EXECUTION_FAILED'
        : 'BROWSER_LAUNCH_FAILED';
  } finally {
    if (pool) {
      try {
        if (slot) await pool.clearTaskContexts(slot.slotId);
      } catch {
        result.cleanupFailures++;
      }
      try {
        if (slot) pool.releaseSlot(slot.slotId);
      } catch {
        result.cleanupFailures++;
      }
      try {
        await pool.shutdownBrowserPool();
      } catch {
        result.cleanupFailures++;
      }
    } else if (browser) {
      try {
        await browser.close();
      } catch {
        result.cleanupFailures++;
      }
    }
    if (result.cleanupFailures) result.status = 'FAIL';
  }
  return result;
}
async function run() {
  // Upstream launchers log CDP endpoints. Suppress those messages completely;
  // the only output is the explicitly constructed report below.
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
  process.env.DEBUG = '';
  process.env.PWDEBUG = '0';
  process.env.CHROMIUM_CHANNEL = '';
  const report = {
    schemaVersion: 1,
    status: 'PASS',
    environment: {
      nodeVersion: version(process.versions.node),
      platform: ['linux', 'darwin', 'win32'].includes(process.platform)
        ? process.platform
        : 'OTHER',
      architecture: ['x64', 'arm64'].includes(process.arch) ? process.arch : 'OTHER',
      headful: process.env.PARITY_HEADFUL === '1',
      channel: 'BUNDLED',
      playwrightVersion: 'UNAVAILABLE',
      playwrightExtraVersion: 'UNAVAILABLE',
      stealthVersion: 'UNAVAILABLE'
    },
    modes: []
  };
  try {
    const configuration = { ...paths(), headful: report.environment.headful };
    const engineRequire = createRequire(path.join(configuration.engine, 'upstream/package.json'));
    const dependencies = {
      playwright: engineRequire('playwright'),
      form: require(path.join(configuration.engine, 'checkout-form.cjs'))
    };
    report.environment.playwrightVersion = version(
      engineRequire('playwright/package.json').version
    );
    report.environment.playwrightExtraVersion = version(
      engineRequire('playwright-extra/package.json').version
    );
    report.environment.stealthVersion = version(
      engineRequire('puppeteer-extra-plugin-stealth/package.json').version
    );
    for (const mode of ['NATIVE_PLAYWRIGHT', 'FORMAL_STANDALONE', 'FORMAL_POOL_CDP'])
      report.modes.push(await executeMode(mode, configuration, dependencies));
  } catch (error) {
    report.status = 'FAIL';
    const allowed = [
      'ENGINE_ROOT_NOT_ABSOLUTE',
      'ENGINE_ROOT_INVALID',
      'OUTPUT_ROOT_REQUIRED',
      'OUTPUT_ROOT_NOT_ABSOLUTE',
      'OUTPUT_ROOT_OUTSIDE_ALLOWED_RUNTIME'
    ];
    report.code = allowed.includes(error.parityCode) ? error.parityCode : 'PARITY_SETUP_FAILED';
  }
  if (report.modes.some((mode) => mode.status !== 'PASS')) report.status = 'FAIL';
  const cases = report.modes.flatMap((mode) => mode.cases);
  report.summary = {
    modesPassed: report.modes.filter((mode) => mode.status === 'PASS').length,
    modesFailed: report.modes.filter((mode) => mode.status !== 'PASS').length,
    checksPassed: cases.filter((entry) => entry.status === 'PASS').length,
    checksFailed: cases.filter((entry) => entry.status !== 'PASS').length,
    cleanupFailures: report.modes.reduce((sum, mode) => sum + mode.cleanupFailures, 0)
  };
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}
module.exports = { run };
if (require.main === module || process.env.PARITY_AUTORUN === '1') void run();
