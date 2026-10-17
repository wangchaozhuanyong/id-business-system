/* global document, window, getComputedStyle */
// Synthetic fixtures only. Every business/connector/BitBrowser request is intercepted.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { chromium } from 'playwright';

const origin = 'https://recharge-acceptance.example.invalid';
const localApi = 'http://127.0.0.1:54345';
const debugEndpoint = 'ws://127.0.0.1:54346/devtools/browser/synthetic';
const adminDirectory = resolve(
  process.argv.find((arg) => arg.startsWith('--admin-dir='))?.slice(12) ?? 'apps/admin'
);
const evidence = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice(15) ??
    '.runtime/bitbrowser-recharge-rebuild-20261009/browser'
);
mkdirSync(evidence, { recursive: true });
const assets = resolve(adminDirectory, 'dist');
if (!process.argv.includes('--built')) {
  const { build } = await import('vite');
  await build({ root: adminDirectory });
}
const staticAsset = (route) => {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  const target = resolve(
    assets,
    path.startsWith('/v2/') || path === '/' ? 'index.html' : path.slice(1)
  );
  assert.ok(target.startsWith(assets + sep), '离线资产不得越过构建目录');
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
  };
  return route.fulfill({
    body: readFileSync(target),
    contentType: mime[extname(target)] ?? 'application/octet-stream'
  });
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const officialAccount = 'fixture-account';
const accountKey = hash(officialAccount);
const waitFor = async (check) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('验收条件超时');
};
const id = {
  account: '11111111-1111-4111-8111-111111111111',
  address: '22222222-2222-4222-8222-222222222222',
  proxy: '88888888-8888-4888-8888-888888888888'
};
const timestamp = new Date().toISOString();
const user = {
  id: 'browser-fixture',
  username: 'test-admin',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const address = {
  id: id.address,
  line1: 'Fixture Billing Street',
  country: 'US',
  city: 'Seattle',
  state: 'WA',
  postalCode: '98101',
  status: 'used',
  usedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const settings = {
  connectorUrl: '',
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenConfigured: true,
  localApiTokenMask: '已配置',
  connectorTokenConfigured: false,
  connectorTokenMask: null,
  groupName: '充值验收',
  tagName: '充值',
  proxyType: 'http',
  proxyId: id.proxy,
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: '合成配置',
  updatedAt: timestamp
};
const account = {
  id: id.account,
  emailMasked: 'fixture@example.test',
  registrationCountryCode: 'PH',
  status: 'active',
  subscriptionState: 'never_subscribed',
  currentPlan: null,
  dueAt: null,
  hasPassword: true,
  hasTotp: false,
  remark: null,
  firstLoginNetwork: null,
  lastLoginNetwork: null,
  createdAt: timestamp,
  updatedAt: timestamp
};
const quoted = (plan) => ({
  plan,
  today: { amount: '1100.00', amount_minor: 110000, currency: 'PHP' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'PHP' },
  renewal: { amount: '1100.00', amount_minor: 110000, currency: 'PHP' },
  renewal_interval: 'monthly'
});
const connectionAcceptance = process.argv.includes('--connections');
const cycleAcceptance = process.argv.includes('--cycles');
const startupDiagnosticsAcceptance = process.argv.includes('--startup-diagnostics');
const report = {
  scope: 'OFFLINE_SYNTHETIC_ONLY',
  assetTransport: 'route.fulfill',
  executionTransport: 'web_direct',
  realNetworkRequests: 0,
  builtPreview: process.argv.includes('--built'),
  realPayment: 'NOT_MEASURED',
  cases: []
};
let browser;
let lastPage;
const diagnosticText = (value) =>
  String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /((?:password|token|secret|nonce|cvc|securityCode)["'\s:=]+)[^\s,"'}]+/gi,
      '$1[redacted]'
    )
    .replace(/\b\d{12,19}\b/g, '[redacted-number]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted-email]')
    .slice(0, 1800);
const diagnosticUrl = (value) => {
  const url = new URL(value);
  return url.origin + url.pathname;
};
let lastDiagnostics;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width, height: 1100 }
    });
    await context.addInitScript((fixture) => {
      localStorage.setItem('apple_business_access_token', 'browser-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
    }, user);
    const page = await context.newPage();
    lastPage = page;
    page.setDefaultTimeout(12_000);
    const errors = [],
      forbidden = [],
      jobs = [],
      local = new Map();
    const diagnostics = { width, phase: 'initial', console: [], pageErrors: [], unmatchedApi: [] };
    lastDiagnostics = diagnostics;
    const profileA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const profileB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const profiles = [
      { id: profileA, name: '办公室电脑' },
      { id: profileB, name: '另一台电脑' }
    ];
    const profileSettings = new Map(
      profiles.map((item) => [
        item.id,
        {
          ...settings,
          connectionProfileId: item.id,
          connectionProfileName: item.name,
          connectionProfiles: profiles
        }
      ])
    );
    let profileSaves = 0;
    let localReachable = true,
      apiStarts = 0,
      onlyLoginStarts = 0,
      starts = 0,
      confirmations = 0,
      slowRefresh = false,
      refreshSeen = false;
    let activeEntry, fingerprint;
    page.on('pageerror', (error) => {
      errors.push(diagnosticText(error.message));
      diagnostics.pageErrors.push(diagnosticText(error.stack ?? error.message));
    });
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.console.push({ type: message.type(), text: diagnosticText(message.text()) });
      }
    });
    const success = (route, data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data })
      });
    const officialPlan = (plan) => (plan === 'go' ? 'chatgptgoplan' : 'chatgptplusplan');
    const nativeOrder = (entry) => ({
      checkout_session_id: entry.sid,
      processor_entity: 'openai_llc',
      plan_name: officialPlan(entry.job.plan),
      status: 'open',
      payment_status: 'unpaid',
      checkout_state: {
        id: entry.sid,
        currency: 'php',
        lineItems: [{ quantity: 1, recurring: { interval: 'month', intervalCount: 1 } }],
        taxAmounts: [],
        total: { total: { minorUnitsAmount: 110000 } },
        billingAddress: {
          name: entry.fields.name,
          address: {
            country: entry.fields.country,
            line1: entry.fields.line1,
            line2: entry.fields.line2 ?? '',
            city: entry.fields.city,
            state: entry.fields.state,
            postal_code: entry.fields.postal_code
          }
        }
      }
    });
    const argumentsOf = (expression) =>
      JSON.parse(
        '[' +
          expression
            .slice(expression.lastIndexOf(')(') + 2, -1)
            .replace(/,undefined(?=,|$)/g, ',null') +
          ']'
      );
    await context.routeWebSocket('**/*', (socket) => {
      assert.equal(socket.url(), debugEndpoint, '只允许合成窗口调试通道');
      const entry = activeEntry;
      const event = (method, params) =>
        socket.send(JSON.stringify({ method, params, sessionId: 'owned-session' }));
      const observe = (path, data, body) => {
        const requestId = 'synthetic-' + ++entry.requests;
        const claims = {
          'https://api.openai.com/auth': { chatgpt_account_id: officialAccount },
          exp: Math.floor(Date.now() / 1000) + 3600
        };
        entry.body.set(requestId, JSON.stringify(body));
        event('Network.requestWillBeSent', {
          requestId,
          request: {
            url: 'https://chatgpt.com' + path,
            method: 'POST',
            headers: {
              authorization:
                'Bearer synthetic.' +
                Buffer.from(JSON.stringify(claims)).toString('base64url') +
                '.synthetic',
              'chatgpt-account-id': officialAccount
            },
            postData: JSON.stringify(data)
          }
        });
        event('Network.responseReceived', { requestId, response: { status: 200 } });
        event('Network.loadingFinished', { requestId });
      };
      socket.onMessage(async (raw) => {
        const command = JSON.parse(String(raw));
        let result = {};
        try {
          const { method, params = {} } = command;
          if (method === 'Target.getTargets')
            result = {
              targetInfos: [{ targetId: 'synthetic-target', type: 'page', url: entry.url }]
            };
          else if (method === 'Target.createTarget') result = { targetId: 'synthetic-target' };
          else if (method === 'Target.attachToTarget') result = { sessionId: 'owned-session' };
          else if (method === 'Browser.getVersion') result = { product: 'Chrome/124.0.0.0' };
          else if (method === 'Network.getCookies') result = { cookies: entry.cookies ?? [] };
          else if (method === 'Network.setCookies') {
            entry.cookies = params.cookies;
            entry.authenticated = true;
          } else if (method === 'Page.navigate') entry.url = params.url;
          else if (method === 'Page.getFrameTree')
            result = { frameTree: { frame: { id: 'synthetic-frame', url: entry.url } } };
          else if (method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
          else if (method === 'Network.getResponseBody')
            result = { body: entry.body.get(params.requestId), base64Encoded: false };
          else if (method === 'Runtime.evaluate') {
            const expression = params.expression;
            let value;
            if (expression.includes('/cdn-cgi/trace')) value = { kind: 'proxy_ready' };
            else if (
              expression.includes('page_ready') &&
              expression.includes('accounts-profile-button')
            )
              value = { kind: entry.manual ? 'manual' : 'page_ready' };
            else if (expression.includes('session_error') && expression.includes('email_login')) {
              const [action] = argumentsOf(expression);
              if (action === 'clear') value = { kind: 'cleared' };
              else if (entry.manual) value = { kind: 'manual' };
              else if (entry.authenticated)
                value = {
                  kind: 'identity',
                  email: 'fixture@example.test',
                  userId: 'fixture-user',
                  accountId: officialAccount,
                  plan: entry.current
                };
              else if (action === 'submit') {
                entry.loginStep = entry.loginStep === 'password' ? 'identity' : 'password';
                entry.authenticated = entry.loginStep === 'identity';
                value = { kind: 'submitted' };
              } else if (['email', 'password'].includes(action))
                value = { kind: 'filled', valueMatches: true };
              else value = { kind: entry.loginStep ?? 'email' };
            } else if (expression.includes('cc-number') && expression.includes('expectedCount')) {
              const [operation] = argumentsOf(expression);
              if (operation.mode === 'fill') {
                if (!entry.allowBilling)
                  await new Promise((resolve) => {
                    entry.releaseBilling = resolve;
                  });
                entry.fields[operation.field] = operation.value;
                value = { ok: true, nodes: [] };
              } else if (operation.mode === 'preferences') value = { ok: true, nodes: [] };
              else
                value = {
                  ok: true,
                  nodes: [
                    {
                      index: 0,
                      count: 1,
                      editable: true,
                      populated: !!entry.fields[operation.field],
                      matches: (entry.fields[operation.field] ?? '') === operation.value,
                      select: operation.field === 'country',
                      optionMatches: 1
                    }
                  ]
                };
            } else if (expression.includes('checkout_mismatch')) {
              const [, action, expected] = argumentsOf(expression);
              if (action === 'prepare') value = { kind: 'plan_ready' };
              else if (action === 'create') {
                if (!entry.upgrading) {
                  entry.url = 'https://chatgpt.com/checkout/openai_llc/' + entry.sid;
                  observe(
                    '/backend-api/payments/checkout',
                    { plan_name: officialPlan(entry.job.plan) },
                    nativeOrder(entry)
                  );
                }
                value = { kind: 'submitted' };
              } else if (action === 'confirm') {
                assert.equal(expected, entry.sid);
                assert.equal(entry.used, true, '必须先受理单次授权再点击官网');
                assert.equal(entry.clicked ?? 0, 0);
                entry.clicked = 1;
                observe(
                  '/backend-api/payments/checkout/confirm',
                  { checkout_session_id: entry.sid },
                  {
                    checkout_session_id: entry.sid,
                    payment_intent: {
                      object: 'payment_intent',
                      id: 'pi_Synthetic' + width,
                      status: 'succeeded',
                      amount_received: 110000,
                      currency: 'php'
                    }
                  }
                );
                entry.current = entry.job.plan;
                value = { kind: 'submitted' };
              } else
                value = {
                  kind: 'page',
                  checkoutId: entry.sid,
                  entity: 'openai_llc',
                  text: 'Total due today PHP 1100.00\nTax PHP 0.00\nThen PHP 1100.00 / month'
                };
            } else if (expression.includes('plan-upgrade-payment-method')) {
              const [action] = argumentsOf(expression);
              if (action === 'confirm') {
                assert.equal(entry.used, true);
                assert.equal(entry.clicked ?? 0, 0);
                entry.clicked = 1;
                observe(
                  '/backend-api/subscriptions/update',
                  {
                    account_id: officialAccount,
                    updated_plan: officialPlan(entry.job.plan),
                    payment_method_id: 'pm_Synthetic'
                  },
                  {
                    payment_intent: {
                      object: 'payment_intent',
                      id: 'pi_Synthetic' + width,
                      status: 'succeeded',
                      amount_received: 110000,
                      currency: 'php'
                    }
                  }
                );
                entry.current = entry.job.plan;
                value = { kind: 'submitted' };
              } else
                value = {
                  kind:
                    action === 'inspect'
                      ? 'ready'
                      : ['select', 'selected'].includes(action)
                        ? 'selected'
                        : 'submitted',
                  text: 'ChatGPT Plus\nPHP 1100.00\nBilled monthly\nTotal due today PHP 1100.00\nTax PHP 0.00'
                };
            } else if (expression.includes('/api/auth/session')) {
              const [, path] = argumentsOf(expression);
              let data;
              if (path.includes('/accounts/check/'))
                data = {
                  accounts: {
                    [officialAccount]: {
                      account: { account_id: officialAccount, plan_type: entry.current },
                      entitlement: { has_active_subscription: entry.current !== 'free' }
                    }
                  }
                };
              else if (path.includes('/payments/checkout/')) data = nativeOrder(entry);
              else if (path.includes('payment_methods'))
                data = {
                  account_id: officialAccount,
                  payment_methods: [
                    {
                      id: 'pm_Synthetic',
                      type: 'card',
                      card: { last4: '4444', exp_month: 12, exp_year: 2030 },
                      billing_details: {
                        name: 'Fixture Person',
                        address: {
                          country: address.country,
                          line1: address.line1,
                          line2: '',
                          city: address.city,
                          state: address.state,
                          postal_code: address.postalCode
                        }
                      }
                    }
                  ]
                };
              else if (path.includes('/update/preview'))
                data = {
                  currency: 'php',
                  positive_line_item_total: 110000,
                  negative_line_item_total: 0,
                  amount_due: { amount: 110000, amount_excluding_tax: 110000, tax_amount: 0 }
                };
              else if (path.includes('/subscriptions'))
                data = entry.cycle
                  ? {}
                  : {
                      account_id: officialAccount,
                      plan_type: entry.current,
                      is_processor_stripe: true,
                      is_delinquent: false,
                      will_renew: true
                    };
              else throw new Error('未预期的官网只读路径');
              value = { ok: true, status: 200, data };
            } else throw new Error('未预期的合成窗口表达式');
            result = { result: { value } };
          } else
            assert.ok(
              [
                'Network.enable',
                'Page.enable',
                'Runtime.enable',
                'Target.setAutoAttach',
                'Network.setExtraHTTPHeaders',
                'Page.reload',
                'Network.deleteCookies'
              ].includes(method),
              '未预期的窗口命令 ' + method
            );
          socket.send(JSON.stringify({ id: command.id, result }));
        } catch (error) {
          console.error(diagnosticText(error.message));
          errors.push(diagnosticText(error.message));
          socket.send(
            JSON.stringify({ id: command.id, error: { message: 'synthetic protocol rejected' } })
          );
        }
      });
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (url.origin === origin && !path.startsWith('/api/')) return staticAsset(route);
      if (url.origin === origin) {
        if (path === '/api/auth/me') return success(route, user);
        if (path === '/api/auth/session')
          return success(route, { accessToken: 'browser-fixture', user });
        if (path.endsWith('/change-events')) return route.abort();
        if (path.endsWith('/change-versions'))
          return success(route, { generatedAt: timestamp, versions: {} });
        if (path.endsWith('/auto-recharge/jobs') && request.method() === 'GET') {
          if (slowRefresh) {
            refreshSeen = true;
            await new Promise((done) => setTimeout(done, 700));
          }
          return success(route, {
            items: jobs,
            configured: true,
            ...(cycleAcceptance ? { subscriptionCycleProtocol: 1 } : {})
          });
        }
        if (/\/auto-recharge\/jobs\/[^/]+$/.test(path) && request.method() === 'GET')
          return success(
            route,
            jobs.find((job) => job.id === path.split('/').at(-1))
          );
        if (path.endsWith('/bank-recharge/accounts'))
          return success(route, { items: [account], total: 1 });
        if (path.endsWith('/bank-recharge/currencies'))
          return success(route, {
            items: [{ code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true }]
          });
        if (path.endsWith('/bank-recharge/cards') || path.endsWith('/workspace-totp-accounts'))
          return success(route, { items: [] });
        if (path.endsWith(`/bank-recharge/accounts/${id.account}/identity`))
          return success(route, { id: id.account, email: 'fixture@example.test' });
        if (path.endsWith('/login-credential'))
          return success(route, {
            email: 'fixture@example.test',
            password: 'synthetic-password-only'
          });
        if (path.endsWith('/auto-recharge/names/match'))
          return success(route, {
            name: 'Fixture Person',
            confirmed: false,
            cardId: null,
            billingAddressId: null
          });
        if (path.endsWith('/cards/management/availability'))
          return success(route, { available: true });
        if (path.endsWith('/auto-recharge/names/payment-card'))
          return success(route, { cardId: '44444444-4444-4444-8444-444444444444' });
        if (path.endsWith('/auto-recharge/payment-caps'))
          throw new Error('已移除的付款上限不应继续请求');
        if (path.endsWith('/proxy-pool/countries')) return success(route, { items: ['PH'] });
        if (path.endsWith('/proxy-pool'))
          return success(route, {
            items: [
              {
                id: id.proxy,
                countryCode: 'PH',
                kind: 'mobile',
                status: 'active',
                linkMask: '合成代理',
                remark1: '离线验收',
                remark2: '',
                connectionMode: 'extraction',
                protocol: 'http',
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ],
            total: 1
          });
        if (path.endsWith('/auto-recharge/addresses'))
          return success(route, {
            items: [address],
            total: 1,
            page: 1,
            pageSize: 2000,
            totals: { unused: 0, used: 1, disabled: 0 }
          });
        if (path.endsWith('/auto-recharge/bitbrowser-settings')) {
          if (!connectionAcceptance) return success(route, settings);
          if (request.method() === 'PUT') {
            const input = request.postDataJSON();
            profileSaves += 1;
            const saved = {
              ...settings,
              ...input,
              connectionProfileId: input.newConnectionProfile
                ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
                : input.connectionProfileId,
              localApiToken: undefined,
              connectorToken: undefined,
              connectionProfiles: profiles
            };
            if (input.newConnectionProfile)
              profiles.push({ id: saved.connectionProfileId, name: input.connectionProfileName });
            profileSettings.set(saved.connectionProfileId, saved);
            return success(route, saved);
          }
          const selected = url.searchParams.get('connectionProfileId');
          return success(
            route,
            profileSettings.get(selected) ?? {
              ...settings,
              connectionProfileId: null,
              connectionProfileName: '原连接配置',
              connectionProfiles: profiles
            }
          );
        }
        if (path.endsWith('/auto-recharge/bitbrowser-catalog-access'))
          return success(route, {
            connectorUrl: '',
            connectorToken: '',
            localApiUrl: settings.localApiUrl,
            localApiToken: 'b'.repeat(32)
          });
        if (path.endsWith('/bitbrowser-access'))
          return success(route, {
            connectorUrl: '',
            connectorToken: 'c'.repeat(64)
          });
        if (path.endsWith('/next-cycle-confirm') && request.method() === 'POST') {
          const entry = local.get(path.split('/').at(-2));
          assert.ok(entry?.cycle);
          assert.deepEqual(request.postDataJSON(), {
            reviewDigest: 'f'.repeat(64),
            confirmedPreviousCycleEnded: true
          });
          assert.equal(entry.cycleConfirmed, false, '旧周期核实只受理一次');
          assert.equal(confirmations, 2, '核实旧周期不会授权或提交新付款');
          entry.cycleConfirmed = true;
          const cycleReview = {
            ...entry.job.result.cycle_review,
            status: 'ready',
            manualPreviousCycleEnded: true
          };
          entry.job.result = { ...entry.job.result, cycle_review: cycleReview };
          return success(route, { cycleReview });
        }
        if (path.endsWith('/auto-recharge/jobs/bitbrowser-open') && request.method() === 'POST') {
          const input = request.postDataJSON();
          assert.equal(input.directMode, true);
          assert.equal(Object.hasOwn(input, 'details'), false);
          const job = {
            id: input.id,
            chatgptAccountId: id.account,
            plan: 'plus',
            action: 'bitbrowser',
            state: 'running',
            createdAt: timestamp,
            updatedAt: timestamp,
            result: {
              mode: 'open_browser',
              transport: 'web_direct',
              status: 'waiting_browser',
              payment_attempted: false,
              payment_requests_sent: 0
            }
          };
          const entry = {
            job,
            used: false,
            current: 'free',
            authenticated: false,
            manual: ++onlyLoginStarts === 2,
            fields: {},
            requests: 0,
            body: new Map(),
            url: 'https://chatgpt.com/'
          };
          jobs.unshift(job);
          local.set(job.id, entry);
          activeEntry = entry;
          return success(route, {
            id: job.id,
            mode: 'open_browser',
            connectorUrl: '',
            connectorToken: '',
            agentToken: 'a'.repeat(64),
            bitBrowser: {
              localApiUrl: localApi,
              localApiToken: 'b'.repeat(32),
              groupName: settings.groupName,
              tagName: settings.tagName,
              proxyType: 'http',
              dynamicProxyUrl: 'https://proxy.example.invalid/never-called',
              browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, coreVersion: '124' }
            }
          });
        }
        if (path.endsWith('/bitbrowser-cancel')) {
          const entry = local.get(path.split('/').at(-2));
          assert.equal(entry.job.result.mode, 'open_browser');
          entry.job.state = 'finished';
          entry.job.result = {
            ...entry.job.result,
            status: 'cancelled',
            cancellation_confirmed: true,
            payment_attempted: false,
            payment_requests_sent: 0
          };
          return success(route, { id: entry.job.id });
        }
        if (path.endsWith('/auto-recharge/jobs/bitbrowser') && request.method() === 'POST') {
          const input = request.postDataJSON();
          assert.equal(JSON.stringify(input).includes('5555555555554444'), false);
          assert.equal(input.manualPaymentConfirmation, true);
          assert.equal(input.authorizeSinglePayment, true);
          assert.equal(Object.hasOwn(input, 'maxAmount'), false);
          assert.equal(input.addressId, id.address);
          assert.equal(input.directMode, true);
          const ordinal = ++apiStarts;
          const upgrading = ordinal === 2;
          const cycle = cycleAcceptance && ordinal === 3;
          assert.equal(input.subscriptionCycleProtocol, cycleAcceptance ? 1 : undefined);
          const job = {
            id: input.id,
            chatgptAccountId: id.account,
            plan: input.plan,
            action: 'bitbrowser',
            state: 'running',
            createdAt: timestamp,
            updatedAt: timestamp,
            result: {
              status: 'waiting_browser',
              transport: 'web_direct',
              mode: 'payment',
              locked_currency: 'PHP'
            }
          };
          jobs.unshift(job);
          const entry = {
            job,
            nonce: 'n'.repeat(64),
            digest: 'd'.repeat(64),
            used: false,
            upgrading,
            cycle,
            cycleConfirmed: false,
            current: upgrading ? 'go' : 'free',
            authenticated: false,
            fields: { country: 'US' },
            revision: 0,
            sid: `oaics_fixture_${ordinal}_${width}`,
            body: new Map(),
            requests: 0,
            allowBilling: !(process.argv.includes('--quote-stages') && ordinal === 1),
            url: 'https://chatgpt.com/'
          };
          local.set(job.id, entry);
          activeEntry = entry;
          return success(route, {
            id: input.id,
            mode: 'payment',
            transport: 'web_direct',
            ...(cycleAcceptance ? { subscriptionCycleProtocol: 1 } : {}),
            connectorUrl: '',
            connectorToken: '',
            agentToken: 'a'.repeat(64),
            ...(input.useSavedCredentials
              ? {
                  savedLogin: {
                    email: 'fixture@example.test',
                    password: 'synthetic-password-only'
                  }
                }
              : {}),
            bitBrowser: {
              localApiUrl: settings.localApiUrl,
              localApiToken: 'b'.repeat(32),
              groupName: settings.groupName,
              tagName: settings.tagName,
              proxyType: 'http',
              dynamicProxyUrl: 'https://proxy.example.invalid/never-called',
              browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, coreVersion: '124' }
            },
            address,
            safety: {
              lockedCurrency: 'PHP',
              authorizeSinglePayment: true,
              manualPaymentConfirmation: true
            }
          });
        }
        if (/\/auto-recharge\/local\//.test(path)) {
          const entry = local.get(path.split('/').at(-1));
          assert.ok(entry);
          assert.equal(request.headers()['x-recharge-local'], 'a'.repeat(64));
          const input = request.postDataJSON();
          assert.ok(
            !JSON.stringify(input).includes('5555555555554444'),
            '银行卡不得进入服务端回调'
          );
          const cycleReview = () => ({
            protocol: 1,
            status: entry.cycleConfirmed ? 'ready' : 'awaiting_previous_cycle_confirmation',
            reviewDigest: 'f'.repeat(64),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            reason: 'previous_period_unavailable'
          });
          if (input.type === 'restore')
            return success(route, {
              records: [],
              staleProfiles: [],
              ...(entry.cycle
                ? {
                    nextCycleContext: {
                      protocol: 1,
                      jobId: entry.job.id,
                      accountKey,
                      targetPlan: entry.job.plan,
                      sources: [
                        {
                          fileKey: 'payments/' + hash('old-cycle') + '.json',
                          revision: 1,
                          operationIdentifier: 'oaics_old_cycle',
                          documentDigest: 'e'.repeat(64),
                          targetPlan: 'plus'
                        }
                      ]
                    }
                  }
                : {})
            });
          if (input.type === 'prepare_next_subscription_cycle') {
            assert.equal(input.accountKey, accountKey);
            assert.equal(input.subscriptionCycleProtocol, 1);
            if (input.phase === 'commit') assert.equal(entry.cycleConfirmed, true);
            return success(route, {
              cycleReview: cycleReview(),
              ...(input.phase === 'commit'
                ? {
                    nextCycleContext: {
                      grant: {
                        protocol: 1,
                        jobId: entry.job.id,
                        accountKey,
                        targetPlan: entry.job.plan,
                        status: 'granted',
                        reviewDigest: 'f'.repeat(64),
                        expiresAt: new Date(Date.now() + 300000).toISOString(),
                        checkoutFileKey: accountKey + '.json',
                        checkoutRevision: 0
                      }
                    }
                  }
                : {})
            });
          }
          if (input.type === 'ledger') {
            assert.equal(input.revision, entry.revision);
            return success(route, { revision: ++entry.revision });
          }
          if (input.type === 'direct_quote') {
            assert.match(input.result.billing_fingerprint, /^[a-f0-9]{64}$/);
            assert.deepEqual(input.result.quote, quoted(entry.job.plan));
            if (!entry.upgrading)
              for (const field of [
                'number',
                'expiry',
                'cvc',
                'name',
                'line1',
                'city',
                'state',
                'postal_code'
              ])
                assert.ok(entry.fields[field], '填完整资料后才能核价 ' + field);
            entry.job.state = 'awaiting_confirmation';
            entry.job.result = {
              ...entry.job.result,
              ...input.result,
              status: 'awaiting_confirmation',
              quote_digest: entry.digest
            };
            return success(route, {
              ok: true,
              nonce: entry.nonce,
              quote_digest: entry.digest,
              confirmation_expires_at: new Date(Date.now() + 300000).toISOString()
            });
          }
          assert.ok(['progress', 'finished'].includes(input.type), '非预期网页回调 ' + input.type);
          entry.job.result = { ...entry.job.result, ...input.result };
          if (input.type === 'finished') entry.job.state = 'finished';
          else if (input.result.user_action_required)
            entry.job.state = 'awaiting_human_verification';
          if (input.result.stage === 'payment_preparation' && !entry.allowBilling)
            entry.job.result = {
              ...entry.job.result,
              initial_quote: {
                ...quoted(entry.job.plan),
                today: { currency: 'PHP', amount: '9999.00', amount_minor: 999900 }
              },
              quote: {
                ...quoted(entry.job.plan),
                today: { currency: 'PHP', amount: '9999.00', amount_minor: 999900 }
              }
            };
          return success(route, { ok: true });
        }
        if (path.endsWith('/confirm') && request.method() === 'POST') {
          const entry = local.get(path.split('/').at(-2));
          const input = request.postDataJSON();
          assert.deepEqual(Object.keys(input).sort(), [
            'checkoutIdentifier',
            'nonce',
            'quoteDigest'
          ]);
          assert.equal(input.nonce, entry.nonce);
          assert.equal(input.quoteDigest, entry.digest);
          assert.equal(input.checkoutIdentifier, entry.job.result.upgrade_identifier ?? entry.sid);
          assert.equal(entry.used, false, '同一报价只允许一次授权');
          entry.used = true;
          confirmations++;
          return success(route, {
            id: entry.job.id,
            paymentAllowed: true,
            paymentRecordRevision: 1
          });
        }
        if (request.method() !== 'GET') {
          forbidden.push(path);
          return route.abort();
        }
        diagnostics.unmatchedApi.push({ method: request.method(), path });
        return success(route, {});
      }
      if (url.origin === localApi) {
        if (!localReachable) return route.abort('connectionrefused');
        const input = request.postDataJSON() ?? {};
        const reply = (data) =>
          route.fulfill({
            headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
            json: { success: true, data }
          });
        if (request.method() === 'OPTIONS') return reply({});
        if (path === '/health') return reply({});
        if (path === '/group/list')
          return reply({ list: [{ id: 'group-fixture', groupName: settings.groupName }] });
        if (path === '/browserTag/list')
          return reply([{ id: 'b'.repeat(32), tagName: settings.tagName }]);
        if (path === '/browser/list') return reply({ list: [] });
        if (path === '/browser/update') {
          fingerprint = input.browserFingerPrint;
          return reply({ id: 'c'.repeat(32) });
        }
        if (path === '/browserTag/updateRelation' || path === '/browser/close') return reply({});
        if (path === '/browser/detail')
          return reply({
            id: 'c'.repeat(32),
            browserFingerPrint: fingerprint,
            syncTabs: false,
            syncCookies: false,
            syncLocalStorage: false,
            syncIndexedDb: false,
            syncAuthorization: false
          });
        if (path === '/browser/open') {
          if (activeEntry.job.result.mode !== 'open_browser') starts++;
          return reply({ ws: debugEndpoint, coreVersion: '124' });
        }
        throw new Error('未预期的合成本地接口 ' + path);
      }
      forbidden.push(url.origin + path);
      return route.abort();
    });
    await page.goto(origin + '/v2/auto-recharge');
    const form = page.locator('.recharge-entry-panel');
    await form.waitFor();
    // Preserve Vue's production error handler and record only bounded diagnostics.
    await page.evaluate(() => {
      window.__rechargeAcceptanceVueErrors = [];
      const app = document.querySelector('#app')?.__vue_app__;
      const original = app?.config.errorHandler;
      if (original) {
        app.config.errorHandler = (error, ...args) => {
          window.__rechargeAcceptanceVueErrors.push(String(error?.stack ?? error));
          return original(error, ...args);
        };
      }
    });
    const assertPageHealthy = async (phase) => {
      diagnostics.phase = phase;
      const runtime = await page.evaluate(() => ({
        vueErrors: window.__rechargeAcceptanceVueErrors ?? [],
        hasOverlay: Boolean(document.querySelector('.app-route-error'))
      }));
      assert.equal(runtime.hasOverlay, false, `${phase} 不得产生运行时错误遮罩`);
      assert.deepEqual(runtime.vueErrors.map(diagnosticText), [], `${phase} 不得产生 Vue 异常`);
      assert.deepEqual(errors, [], `${phase} 不得产生页面或合成协议异常`);
    };
    assert.equal(await page.getByRole('radio', { name: '服务器充值', exact: true }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: '已保存账号', exact: true }).count(), 0);
    await page.getByText('账号自动登录', { exact: true }).click();
    await page
      .getByRole('combobox', { name: /ChatGPT 账号/ })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: /fixture@example.test/ }).click();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).count(), 0);
    const jsonInput = page.getByPlaceholder(/粘贴完整授权 JSON|授权已自动载入，可粘贴新 JSON 替换/);
    const loadJson = async (email = 'fixture@example.test', token = 'synthetic-only') => {
      await page
        .getByRole('radio', { name: '授权 JSON', exact: true })
        .locator('xpath=ancestor::label')
        .click();
      await jsonInput.fill(
        JSON.stringify({
          sessionToken: token,
          user: { id: 'fixture-user', email },
          account: { id: officialAccount }
        })
      );
      await page.getByText('授权已自动载入', { exact: false }).waitFor();
    };
    await loadJson();
    await loadJson('replacement@example.test', 'replacement-synthetic-only');
    await form.getByText('replacement@example.test', { exact: true }).waitFor();
    assert.equal(await jsonInput.inputValue(), '', '第二份授权载入后清空粘贴框');
    await jsonInput.fill('{"sessionToken":');
    await page
      .getByText('授权 JSON 格式不完整或无效，请重新复制完整的单账户授权', { exact: true })
      .waitFor();
    assert.equal(
      await form.getByText('replacement@example.test', { exact: true }).count(),
      0,
      '错误授权不能保留旧账号'
    );
    await jsonInput.fill(JSON.stringify({ padding: 'x'.repeat(65_001) }));
    await page.getByText('授权 JSON 超过 65 KB，请提供单账户授权文件', { exact: true }).waitFor();
    await loadJson();
    assert.equal(await jsonInput.getAttribute('type'), 'text');
    assert.equal(
      await jsonInput.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'disc'
    );
    await form.getByLabel('窗口名称', { exact: true }).fill('充值离线验收');
    assert.equal(await form.getByLabel('最高付款', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/付款安全上限|付款上限设置/).count(), 0);
    await page
      .getByRole('combobox', { name: '选择真实账单地址' })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: address.line1, exact: true }).click();
    const proxyCountry = page.getByRole('combobox', { name: '选择代理国家', exact: true });
    assert.equal(await proxyCountry.getAttribute('readonly'), '', '国家选择不触发地址文本输入');
    await proxyCountry
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: '菲律宾', exact: true }).click();
    await page
      .getByRole('combobox', { name: '选择代理 IP', exact: true })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: /离线验收/ }).click();
    const fillPayment = async () => {
      await form.getByLabel('银行卡号', { exact: true }).fill('5555555555554444');
      const billingName = form.getByLabel('账单姓名', { exact: true });
      await waitFor(async () => (await billingName.inputValue()) === 'Fixture Person');
      assert.equal(await billingName.getAttribute('readonly'), '');
      await form.getByLabel('有效期', { exact: true }).fill('1230');
      await form.getByLabel('安全码', { exact: true }).fill('123');
      const authorization = form.getByRole('checkbox', { name: /我已核对银行卡/ });
      if (!(await authorization.isChecked()))
        await authorization.locator('xpath=ancestor::label').click();
    };
    const choosePlan = async (label) => {
      await form
        .getByRole('combobox', { name: /开通套餐|目标套餐/ })
        .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
        .click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    await choosePlan('ChatGPT Go');
    await fillPayment();
    const cardNumber = form.getByLabel('银行卡号', { exact: true });
    const cvc = form.getByLabel('安全码', { exact: true });
    for (const input of [cardNumber, cvc]) {
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(
        await input.evaluate((node) => getComputedStyle(node).webkitTextSecurity),
        'disc'
      );
    }
    const cardField = form.locator('.recharge-card-number');
    await cardField.getByRole('button', { name: '显示内容', exact: true }).click();
    assert.equal(
      await cardNumber.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'none'
    );
    assert.equal(await cardNumber.inputValue(), '5555555555554444', '切换遮蔽不修改银行卡输入');
    await cardField.getByRole('button', { name: '隐藏内容', exact: true }).press('Space');
    assert.equal(
      await cardNumber.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'disc'
    );
    assert.equal(
      await form.locator('input[type="password"]').count(),
      0,
      '充值资料不构成本站密码表单'
    );
    await cardNumber.focus();
    await page.screenshot({
      path: resolve(evidence, `masked-inputs-${width}.png`),
      fullPage: true
    });
    const start = page.getByRole('button', { name: '在比特浏览器执行', exact: true });
    assert.equal(await start.isEnabled(), true);
    localReachable = false;
    await start.click();
    await page
      .getByText(/网页无法访问比特浏览器/)
      .first()
      .waitFor();
    assert.equal(apiStarts, 0);
    assert.equal(starts, 0);
    localReachable = true;
    await start.click();
    const confirm = page.getByRole('button', { name: /确认.*付款|确认.*扣款/ });
    if (process.argv.includes('--quote-stages')) {
      await page.getByText('初始参考报价（银行卡与完整账单资料填写前）', { exact: true }).waitFor();
      assert.equal(await confirm.count(), 0, '填写资料和重新计税前不能确认付款');
      const result = page.locator('.recharge-result');
      const finalAmounts = result.locator('.recharge-quote').nth(1);
      assert.match(await finalAmounts.innerText(), /待完整填写资料并重新计税/);
      assert.equal(
        (await finalAmounts.innerText()).includes('9999.00'),
        false,
        '初始价不能充当最终应付'
      );
      await page.screenshot({
        path: resolve(evidence, `initial-reference-${width}.png`),
        fullPage: true
      });
      const entry = local.get(jobs[0].id);
      entry.allowBilling = true;
      entry.releaseBilling?.();
      await page.getByRole('button', { name: '刷新原任务状态', exact: true }).click();
      await confirm.waitFor();
      assert.ok((await finalAmounts.innerText()).includes(quoted(jobs[0].plan).today.amount));
      assert.equal((await finalAmounts.innerText()).includes('9999.00'), false);
      for (const theme of ['light', 'dark']) {
        if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
        await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
        await page.setViewportSize({ width, height: 1100 });
        await page.keyboard.press('Escape');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
          false
        );
        await page.screenshot({
          path: resolve(evidence, `final-quote-${theme}-${width}.png`),
          fullPage: true
        });
      }
    }
    await confirm.waitFor();
    assert.equal(confirmations, 0);
    assert.equal(jobs[0].result.nonce, undefined, '后端不得持久化付款授权');
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(confirmations, 1);
    assert.equal(await form.getByLabel('安全码', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: /继续.*账号.*升级/ }).click();
    await loadJson();
    await choosePlan('ChatGPT Plus');
    await fillPayment();
    await start.click();
    await confirm.waitFor();
    await page
      .getByText(/Go.*Plus|Go → Plus/)
      .first()
      .waitFor();
    assert.equal(confirmations, 1);
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(confirmations, 2);
    await page.waitForFunction(
      () => document.querySelectorAll('.recharge-entry-panel .el-form-item__error').length === 0
    );
    assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0].id, jobs[1].id);
    assert.ok(jobs.every((job) => job.chatgptAccountId === id.account));
    if (cycleAcceptance) {
      await page.getByRole('button', { name: /继续.*账号.*升级/ }).click();
      await loadJson();
      await choosePlan('ChatGPT Plus');
      await fillPayment();
      await start.click();
      const review = page.getByRole('button', { name: '核实旧周期已结束', exact: true });
      await review.waitFor();
      assert.equal(confirmations, 2, '只读周期核实没有发送付款');
      assert.equal(await confirm.count(), 0, '旧周期核实阶段不显示付款确认');
      assert.equal(await page.getByRole('button', { name: '继续原任务', exact: true }).count(), 0);
      for (const theme of ['light', 'dark']) {
        if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
        await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
        if (width < 900) await page.setViewportSize({ width, height: 1100 });
        if (width < 900) {
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => document.querySelector('.v2-sidebar').getBoundingClientRect().right <= 0
          );
        }
        await review.click();
        const dialog = page.getByRole('dialog', { name: '核实旧订阅周期', exact: true });
        await dialog.waitFor();
        assert.equal((await dialog.getByText(/不授权扣款/).count()) > 0, true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
          false,
          '核实弹窗在窄屏不能产生横向溢出'
        );
        await page.screenshot({
          path: resolve(evidence, `cycle-review-${theme}-${width}.png`),
          fullPage: true,
          animations: 'disabled'
        });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      }
      await review.click();
      const dialog = page.getByRole('dialog', { name: '核实旧订阅周期', exact: true });
      await dialog.getByRole('button', { name: '确认旧周期已结束', exact: true }).click();
      await confirm.waitFor();
      assert.equal(confirmations, 2, '人工核实旧周期也没有授权付款');
      await confirm.click();
      await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
      assert.equal(confirmations, 3, '新周期仍需独立一次官网报价确认');
      assert.equal(local.get(jobs[0].id).cycleConfirmed, true);
      assert.equal(jobs.length, 3);
      assert.equal(new Set(jobs.map((job) => job.id)).size, 3, '三个任务保持不同原操作');
    }
    slowRefresh = true;
    await page.getByRole('button', { name: '刷新原任务状态', exact: true }).click();
    await waitFor(() => refreshSeen);
    assert.equal(
      await page.locator('.recharge-status').filter({ hasText: '开通成功' }).isVisible(),
      true
    );
    assert.equal(await page.locator('.el-loading-mask').count(), 0);
    assert.equal(
      await page.locator('.recharge-page > .v2-async-region').getAttribute('data-v2-query-phase'),
      'refreshing'
    );
    slowRefresh = false;
    await page.getByRole('button', { name: '刷新原任务状态', exact: true }).waitFor();
    await waitFor(() =>
      page.getByRole('button', { name: '刷新原任务状态', exact: true }).isEnabled()
    );
    for (const theme of ['light', 'dark']) {
      // Theme controls are desktop shell controls; keep narrow acceptance on the same live page.
      if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
      await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
      if (width < 900) await page.setViewportSize({ width, height: 1100 });
      // Wait for the existing navigation transition before measuring the narrow page.
      if (width < 900) {
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.querySelector('.v2-sidebar').getBoundingClientRect().right <= 0
        );
      }
      // Element Plus controls animate theme changes; verify the settled shared surface.
      await page.waitForFunction(() => {
        const element = document.querySelector('.recharge-entry-panel .el-select__wrapper');
        const style = getComputedStyle(element);
        const normalized = document.createElement('span');
        normalized.style.backgroundColor = style.getPropertyValue('--v3-surface').trim();
        return style.backgroundColor === normalized.style.backgroundColor;
      });
      await page.screenshot({
        path: resolve(evidence, theme + '-' + width + '.png'),
        fullPage: true
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
        false
      );
      const alignment = await form.locator('.el-form-item:visible').evaluateAll((elements) =>
        elements.every((element) => {
          const label = element.querySelector('.el-form-item__label');
          const content = element.querySelector('.el-form-item__content');
          if (!label || !content) return true;
          const a = label.getBoundingClientRect(),
            b = content.getBoundingClientRect();
          return a.left <= b.left && Math.abs(a.top - b.top) < 8;
        })
      );
      assert.equal(alignment, true, '标签须在控件左侧并对齐首行');
      report.skin ??= [];
      report.skin.push(
        await form
          .locator('.el-select__wrapper')
          .first()
          .evaluate((element, theme) => {
            const style = getComputedStyle(element);
            const root = getComputedStyle(document.documentElement);
            return {
              theme,
              background: style.backgroundColor,
              fill: style.getPropertyValue('--el-fill-color-blank'),
              rootFill: root.getPropertyValue('--el-fill-color-blank'),
              surface: style.getPropertyValue('--v3-surface'),
              color: style.color
            };
          }, theme)
      );
      if (connectionAcceptance) {
        await page.getByRole('button', { name: '比特浏览器直连设置', exact: true }).click();
        const drawer = page
          .getByRole('dialog')
          .filter({ has: page.getByRole('combobox', { name: '选择本人的连接配置' }) });
        const choose = async (label) => {
          await drawer
            .getByRole('combobox', { name: '选择本人的连接配置' })
            .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
            .click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await waitFor(() =>
            drawer
              .getByLabel('配置名称', { exact: true })
              .inputValue()
              .then((value) => value === label)
          );
        };
        if (theme === 'light') {
          await choose('办公室电脑');
          await drawer.getByLabel('配置名称', { exact: true }).fill('办公室未保存输入');
          await choose('另一台电脑');
          await drawer.getByLabel('配置名称', { exact: true }).fill('另一台未保存输入');
          await drawer
            .getByRole('combobox', { name: '选择本人的连接配置' })
            .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
            .click();
          await page.getByRole('option', { name: '办公室电脑', exact: true }).click();
          await waitFor(() =>
            drawer
              .getByLabel('配置名称', { exact: true })
              .inputValue()
              .then((value) => value === '办公室未保存输入')
          );
          assert.equal(profileSaves, 0, '切换配置不会覆盖任何已保存配置');
        }
        await drawer.getByText('本人的连接配置', { exact: true }).click();
        await drawer.getByRole('button', { name: '检测完整连接', exact: true }).click();
        await drawer.getByText('比特浏览器直连、分组／标签检测通过', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
          false
        );
        const aligned = await drawer.locator('.el-form-item:visible').evaluateAll((items) =>
          items.every((item) => {
            const label = item.querySelector('.el-form-item__label')?.getBoundingClientRect();
            const content = item.querySelector('.el-form-item__content')?.getBoundingClientRect();
            return (
              !label ||
              !content ||
              (label.left < content.left && Math.abs(label.top - content.top) < 8)
            );
          })
        );
        assert.equal(aligned, true, '连接配置表单保持左侧标签和首行对齐');
        await page.screenshot({
          path: resolve(evidence, 'connections-' + theme + '-' + width + '.png'),
          fullPage: true
        });
        await drawer.getByRole('button', { name: '恢复已保存配置', exact: true }).click();
        await waitFor(() =>
          drawer
            .getByLabel('配置名称', { exact: true })
            .inputValue()
            .then((value) => value === '办公室电脑')
        );
        await drawer.getByRole('button', { name: '关闭', exact: true }).last().click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
      if (width < 900) {
        await page.locator('.recharge-status-panel').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(evidence, theme + '-' + width + '-result.png') });
        await form.scrollIntoViewIfNeeded();
      }
    }
    // A real route transition must retain the non-sensitive draft but clear one-time secrets.
    diagnostics.phase = 'draft-route-away';
    await page.getByRole('button', { name: /继续.*账号.*升级/ }).click();
    await page
      .getByRole('radio', { name: '账号自动登录', exact: true })
      .locator('xpath=ancestor::label')
      .click();
    await form.getByLabel('窗口名称', { exact: true }).fill('升级草稿保留验收');
    await fillPayment();
    if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
    // Use a real, fixture-backed sibling route and wait for its content before going back.
    await page.locator('.v2-navigation a[href="/v2/auto-recharge/addresses"]').click();
    await page.waitForURL('**/v2/auto-recharge/addresses');
    await page
      .locator('.recharge-address-page [data-v2-query-phase="ready"]')
      .getByText(address.line1, { exact: true })
      .waitFor();
    await assertPageHealthy('draft-route-destination-ready');
    diagnostics.phase = 'draft-route-back';
    await page.goBack();
    await page.waitForURL('**/v2/auto-recharge');
    await form.waitFor();
    await assertPageHealthy('draft-route-return-ready');
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(
      await form.getByLabel('窗口名称', { exact: true }).inputValue(),
      '升级草稿保留验收'
    );
    assert.equal(await form.getByLabel('安全码', { exact: true }).inputValue(), '');
    assert.equal(await form.getByRole('checkbox', { name: /我已核对银行卡/ }).isChecked(), false);
    assert.equal(await form.getByRole('combobox', { name: /ChatGPT 账号/ }).inputValue(), '');
    assert.match(
      await form
        .getByRole('combobox', { name: /ChatGPT 账号/ })
        .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")][1]')
        .innerText(),
      /fixture@example.test/
    );
    assert.ok(await form.getByText(address.line1, { exact: true }).count());
    if (startupDiagnosticsAcceptance) {
      const requestsBeforeDiagnostics = confirmations;
      const requestId = 'synthetic-' + 'a'.repeat(118);
      jobs[0].state = 'finished';
      jobs[0].result = {
        status: 'blocked',
        reason: 'durable_state_unavailable',
        stage: 'connector_dispatch',
        payment_attempted: false,
        payment_requests_sent: 0,
        callback_operation: 'restore',
        callback_http_status: 409,
        callback_failure_kind: 'http',
        callback_error_code: 'CONFLICT',
        callback_business_reason: 'callback_original_checkout_mismatch',
        callback_request_id: requestId,
        callback_raw_body: 'DIAGNOSTIC_SECRET_MUST_NOT_DISPLAY'
      };
      await page.getByRole('button', { name: '刷新原任务状态', exact: true }).click();
      // The draft test clears the selected task. Select the synthetic record
      // through the normal history drawer before checking its diagnosis.
      await page.getByRole('button', { name: '最近执行记录', exact: true }).click();
      const history = page.getByRole('dialog', { name: '最近执行记录', exact: true });
      await history.locator('.recharge-history button').first().click();
      await history.locator('.el-drawer__close-btn').click();
      await history.waitFor({ state: 'hidden' });
      const panel = page.locator('.recharge-status-panel');
      await panel
        .getByText(/原结算绑定不一致/)
        .first()
        .waitFor();
      await panel.locator('.recharge-diagnostics > summary').click();
      await panel.getByText(requestId, { exact: true }).waitFor();
      assert.equal((await panel.innerText()).includes('DIAGNOSTIC_SECRET_MUST_NOT_DISPLAY'), false);
      assert.equal((await panel.innerText()).includes('再处理历史付款锁'), false);
      assert.equal(confirmations, requestsBeforeDiagnostics, '诊断展示不触发付款');
      for (const theme of ['light', 'dark']) {
        if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
        await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
        if (width < 900) {
          await page.setViewportSize({ width, height: 1100 });
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => document.querySelector('.v2-sidebar').getBoundingClientRect().right <= 0
          );
        }
        await panel.scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
          false,
          '长请求编号在窄屏不能产生横向溢出'
        );
        await page.screenshot({
          path: resolve(evidence, `startup-diagnostics-${theme}-${width}.png`),
          fullPage: true,
          animations: 'disabled'
        });
      }
    }
    const beforeLoginPayments = confirmations;
    diagnostics.phase = 'login-and-cancel';
    await page
      .getByRole('radio', { name: '仅登录账号', exact: true })
      .locator('xpath=ancestor::label')
      .click();
    const openLogin = page.getByRole('button', { name: '打开比特浏览器并登录', exact: true });
    await waitFor(() => openLogin.isEnabled());
    await openLogin.click();
    await waitFor(() => jobs[0].result.status === 'session_ready');
    assert.equal(jobs[0].result.payment_requests_sent, 0, '仅登录不得付款');
    await page.getByRole('button', { name: '刷新原任务状态', exact: true }).click();
    await waitFor(() => openLogin.isEnabled());
    await openLogin.click();
    await waitFor(() => jobs[0].state === 'awaiting_human_verification');
    await page.getByRole('button', { name: '停止本次任务', exact: true }).waitFor();
    await page.getByRole('button', { name: '停止本次任务', exact: true }).click();
    await waitFor(() => jobs[0].result.cancellation_confirmed === true);
    assert.equal(confirmations, beforeLoginPayments, '登录与取消不能发送任何付款');
    assert.equal(onlyLoginStarts, 2);
    assert.equal(jobs[0].result.payment_requests_sent, 0);
    await assertPageHealthy('login-and-cancel-complete');
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    report.cases.push({
      width,
      apiStarts,
      starts,
      confirmations,
      themes: ['light', 'dark'],
      draftRouteRetention: 'PASS',
      oneTimeSecretsClearedOnRoute: 'PASS',
      refreshRetainsSuccess: 'PASS',
      consecutiveJsonReplacement: 'PASS',
      invalidJsonClearsOldSession: 'PASS',
      sensitiveInputMaskAndReveal: 'PASS',
      countrySelectionReadonly: 'PASS',
      directLoginAndCancellation: 'PASS',
      finalQuoteAfterBilling: process.argv.includes('--quote-stages') ? 'PASS' : 'NOT_RUN',
      connectionProfileDraftIsolation: connectionAcceptance ? 'PASS' : 'NOT_RUN',
      startupCallbackDiagnostics: startupDiagnosticsAcceptance ? 'PASS' : 'NOT_RUN',
      result: 'PASS'
    });
    await context.close();
  }
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    const runtime = await lastPage.evaluate(() => ({
      vueErrors: window.__rechargeAcceptanceVueErrors ?? [],
      overlay: document.querySelector('.app-route-error')?.textContent ?? null
    }));
    const diagnostics = {
      ...lastDiagnostics,
      route: diagnosticUrl(lastPage.url()),
      failure: diagnosticText(error.message),
      vueErrors: runtime.vueErrors.map(diagnosticText),
      overlay: runtime.overlay ? diagnosticText(runtime.overlay) : null
    };
    writeFileSync(
      resolve(evidence, 'failure-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2)
    );
    console.error('[AUTO_RECHARGE_ACCEPTANCE_FAILURE] ' + JSON.stringify(diagnostics));
    await lastPage.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true });
    writeFileSync(resolve(evidence, 'failure.txt'), await lastPage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
}
