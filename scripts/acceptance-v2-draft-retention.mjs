#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3004/api';
const DEFAULT_ADMIN_BASE_URL = 'http://127.0.0.1:5377';
const HTTP_TIMEOUT_MS = 30_000;

const routeDraftChecks = [
  {
    path: '/v2/workbench/renewals',
    placeholder: '订单、客户、ID账号、网站账号'
  },
  {
    path: '/v2/accounts',
    placeholder: 'ID账号、手机号、供应商'
  },
  {
    path: '/v2/orders',
    placeholder: '订单号、客户、平台订单号、账号'
  },
  {
    path: '/v2/customers',
    placeholder: '客户名称、手机号、微信'
  },
  {
    path: '/v2/records/topups',
    placeholder: '礼品卡尾号、ID、供应商'
  },
  {
    path: '/v2/records/activations',
    placeholder: '订单、客户、业务、ID账号'
  },
  {
    path: '/v2/exchange-rates',
    placeholder: '批次编号、错误代码'
  },
  {
    path: '/v2/options',
    placeholder: '搜索选项名称或备注'
  }
];

function loadEnvFile(filePath) {
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      process.env[trimmed.slice(0, separator)] ??= trimmed.slice(separator + 1);
    }
  } catch {
    // Required configuration is reported below.
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

function assertLocalUrl(value, label) {
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), `${label}必须使用本地地址`);
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2901_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const adminBaseUrl = trimTrailingSlash(
    process.env.V2901_ACCEPTANCE_ADMIN_BASE_URL ?? DEFAULT_ADMIN_BASE_URL
  );
  const databaseUrl = process.env.DATABASE_URL;
  const username = process.env.V2901_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2901_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

  assert.ok(databaseUrl, '缺少 V2901 验收 DATABASE_URL');
  assert.ok(username && password, '缺少 V2901 验收管理员账号配置');
  assertLocalUrl(apiBaseUrl, 'V2901 API');
  assertLocalUrl(adminBaseUrl, 'V2901 管理端');
  assert.equal(
    new URL(databaseUrl).pathname.toLowerCase(),
    '/v2901_acceptance',
    'V2901 浏览器验收只能连接名称为 v2901_acceptance 的一次性数据库'
  );

  let token = '';

  async function api(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A short response excerpt is included only when the request fails.
    }
    assert.ok(
      response.ok,
      `${options.method ?? 'GET'} ${path} -> ${response.status}: ${
        json?.message ?? text.slice(0, 180)
      }`
    );
    return json?.data;
  }

  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  assert.ok(login?.accessToken, 'V2901 API 登录未返回 accessToken');
  token = login.accessToken;

  const suffix = `${Date.now()}`.slice(-10);
  const countryName = `V2901 美国 ${suffix}`;
  const categoryName = `V2901 AI 分类 ${suffix}`;
  const serviceName = `V2901 Plus ${suffix}`;
  const customerName = `V2901 客户 ${suffix}`;

  async function createOption(type, name, extra = {}) {
    return api('/id-business-v2/options', {
      method: 'POST',
      body: JSON.stringify({
        type,
        name,
        remark: `V2901 disposable browser acceptance ${suffix}`,
        ...extra
      })
    });
  }

  const statusSelectors = await api('/id-business-v2/options/selectors?type=id_status');
  const normalStatus = statusSelectors.items.find((item) => item.code === 'normal');
  assert.ok(normalStatus, 'V2901 一次性数据库缺少 normal 状态');

  const country = await createOption('country', countryName, { currencyCode: 'USD' });
  const category = await createOption('business_category', categoryName);
  const service = await createOption('service', serviceName, {
    parentId: category.id,
    countryOptionId: country.id,
    businessAmount: '20'
  });
  const supplier = await createOption('id_supplier', `V2901 ID供应商 ${suffix}`);
  const customer = await api('/id-business-v2/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: customerName,
      serviceOptionIds: [service.id],
      remark: 'V2901 disposable browser acceptance'
    })
  });
  const account = await api('/id-business-v2/accounts', {
    method: 'POST',
    body: JSON.stringify({
      appleId: `v2901.${suffix}@example.com`,
      password: `V2901-${suffix}-Password!`,
      countryOptionId: country.id,
      statusOptionId: normalStatus.id,
      supplierOptionId: supplier.id,
      currentBalance: '100',
      balanceCostAmount: '300',
      remark: 'V2901 disposable browser acceptance'
    })
  });
  assert.ok(customer.id && account.id, 'V2901 浏览器验收夹具创建失败');
  const matchingProbe = await api(
    `/id-business-v2/orders/matching-candidates?serviceOptionId=${service.id}&balanceAmount=20`
  );
  assert.equal(
    matchingProbe.selectedCandidateId,
    account.id,
    'V2901 一次性夹具没有形成可自动匹配的 ID'
  );

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const browserErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !message.text().includes('ResizeObserver loop completed with undelivered notifications')
      ) {
        browserErrors.push(`console:${message.text()}`);
      }
    });

    await page.goto(
      `${adminBaseUrl}/login?redirect=${encodeURIComponent('/v2/workbench/order-entry')}`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(password);
    await page.getByRole('button', { name: '登录新版后台', exact: true }).click();
    await page.waitForURL('**/v2/workbench/order-entry', { timeout: HTTP_TIMEOUT_MS });
    await waitForPageReady(page);

    const storageKeysBefore = await readStorageKeys(page);
    await verifyOrderEntryDraft(page, {
      countryName,
      categoryName,
      serviceName,
      customerName
    });

    for (const [index, check] of routeDraftChecks.entries()) {
      await navigateWithinV2(page, check.path);
      const input = page.locator(`input[placeholder="${check.placeholder}"]`).first();
      await input.waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
      const marker = `V2901-${index + 1}`;
      await input.fill(marker);
      const detour = check.path === '/v2/options' ? '/v2/orders' : '/v2/options';
      await navigateWithinV2(page, detour);
      await navigateWithinV2(page, check.path);
      assert.equal(await input.inputValue(), '', `${check.path} 仍被 KeepAlive 保留临时筛选`);
    }

    await verifyOptionsHierarchyAndTransientDrawer(page, {
      countryName,
      categoryName,
      serviceName
    });

    await navigateWithinV2(page, '/v2/workbench/order-entry');
    await assertOrderDraft(page, {
      countryName,
      categoryName,
      serviceName,
      customerName
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPageReady(page);
    await assertOrderDraftCleared(page);

    const storageKeysAfter = await readStorageKeys(page);
    assert.deepEqual(
      storageKeysAfter,
      storageKeysBefore,
      '填写草稿后浏览器存储键发生变化，可能把草稿写入了持久化存储'
    );
    assert.deepEqual(browserErrors, [], `V2901 浏览器错误：${browserErrors.join('; ')}`);
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(
    '[V2901 browser acceptance] PASSED: 订单草稿选择性保留、普通页面临时状态卸载、刷新清空与浏览器存储边界均符合要求'
  );
}

async function navigateWithinV2(page, path) {
  if (new URL(page.url()).pathname === path) {
    await waitForPageReady(page);
    return;
  }
  const link = page.locator(`a[href="${path}"]`).first();
  await link.evaluate((element) => element.click());
  await page.waitForURL((url) => url.pathname === path, { timeout: HTTP_TIMEOUT_MS });
  await waitForPageReady(page);
}

async function waitForPageReady(page) {
  await page
    .locator('.el-loading-mask')
    .waitFor({ state: 'detached', timeout: HTTP_TIMEOUT_MS })
    .catch(() => {});
  const routeError = page.locator('.app-route-error:visible').first();
  if (await routeError.count()) {
    throw new Error(`V2901 路由加载失败：${(await routeError.innerText()).trim()}`);
  }
}

function formItem(page, label) {
  return page.locator('.el-form-item').filter({ hasText: label }).first();
}

async function selectOption(page, label, optionText) {
  const item = formItem(page, label);
  await item.locator('.el-select').click();
  await page
    .locator('.el-select__popper:visible .el-select-dropdown__item:not(.is-disabled)')
    .filter({ hasText: optionText })
    .first()
    .click();
}

async function verifyOrderEntryDraft(page, fixture) {
  await selectOption(page, '国家', fixture.countryName);
  await selectOption(page, '业务分类', fixture.categoryName);
  const matchingResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/id-business-v2/orders/matching-candidates') &&
      response.request().method() === 'GET',
    { timeout: HTTP_TIMEOUT_MS }
  );
  await selectOption(page, '业务名称', fixture.serviceName);
  await selectOption(page, '客户', fixture.customerName);

  await formItem(page, '客户网站账号').locator('input').fill('draft-switch@example.com');
  await formItem(page, '实收金额').locator('input').fill('123.45');
  await formItem(page, '备注').locator('textarea').fill('V2901 页面切换保留测试');

  const matchingResponse = await matchingResponsePromise;
  assert.ok(matchingResponse.ok(), `订单页面自动匹配请求失败：${matchingResponse.status()}`);
  const matchingBody = await matchingResponse.json();
  assert.ok(matchingBody?.data?.selectedCandidateId, '订单页面自动匹配没有返回建议 ID');
  try {
    await page.waitForFunction(
      () => {
        const item = [...globalThis.document.querySelectorAll('.el-form-item')].find((element) =>
          element.textContent?.includes('使用 ID')
        );
        return [...(item?.querySelectorAll('.el-select__selected-item') ?? [])].some((element) =>
          Boolean(element.textContent?.trim())
        );
      },
      null,
      { timeout: HTTP_TIMEOUT_MS }
    );
  } catch (error) {
    const selectHtml = await formItem(page, '使用 ID')
      .locator('.el-select')
      .evaluate((element) => element.outerHTML);
    throw new Error(`自动匹配已返回建议 ID，但页面没有显示选中项：${selectHtml}`, {
      cause: error
    });
  }
  await assertOrderDraft(page, fixture);
  await navigateWithinV2(page, '/v2/options');
  await navigateWithinV2(page, '/v2/workbench/order-entry');
  await assertOrderDraft(page, fixture);
}

async function assertOrderDraft(page, fixture) {
  assert.ok(
    (await selectedOptionText(formItem(page, '国家'))).includes(fixture.countryName),
    '订单国家切页后丢失'
  );
  assert.ok(
    (await selectedOptionText(formItem(page, '业务分类'))).includes(fixture.categoryName),
    '订单业务分类切页后丢失'
  );
  assert.ok(
    (await selectedOptionText(formItem(page, '业务名称'))).includes(fixture.serviceName),
    '订单业务切页后丢失'
  );
  assert.ok(
    (await selectedOptionText(formItem(page, '客户'))).includes(fixture.customerName),
    '订单客户切页后丢失'
  );
  assert.equal(
    await formItem(page, '消耗余额').locator('input').inputValue(),
    '20',
    '选择业务后没有按国家货币对应的业务金额自动带入'
  );
  assert.equal(
    await formItem(page, '客户网站账号').locator('input').inputValue(),
    'draft-switch@example.com'
  );
  assert.equal(await formItem(page, '实收金额').locator('input').inputValue(), '123.45');
  assert.equal(
    await formItem(page, '备注').locator('textarea').inputValue(),
    'V2901 页面切换保留测试'
  );
  assert.ok(await selectedOptionText(formItem(page, '使用 ID')), '自动匹配的 ID 切页后丢失');
}

async function assertOrderDraftCleared(page) {
  assert.equal(await formItem(page, '国家').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '业务分类').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '业务名称').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '客户').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '客户网站账号').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '实收金额').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '消耗余额').locator('input').inputValue(), '');
  assert.equal(await formItem(page, '备注').locator('textarea').inputValue(), '');
}

async function verifyOptionsHierarchyAndTransientDrawer(page, fixture) {
  await navigateWithinV2(page, '/v2/options');

  await page.getByText('业务分类', { exact: true }).first().click();
  await waitForPageReady(page);
  await page.getByRole('button', { name: '新增业务分类', exact: true }).click();
  let drawer = page.locator('.el-drawer:visible');
  await drawer.waitFor({ state: 'visible' });
  assert.equal(await drawer.getByText('上级国家', { exact: true }).count(), 0);
  await drawer.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByText('国家', { exact: true }).first().click();
  await waitForPageReady(page);
  await page.getByRole('button', { name: '新增国家', exact: true }).click();
  drawer = page.locator('.el-drawer:visible');
  await drawer.getByText('默认货币', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByText('开通业务', { exact: true }).first().click();
  await waitForPageReady(page);
  await page.getByRole('button', { name: '新增开通业务', exact: true }).click();
  drawer = page.locator('.el-drawer:visible');
  for (const label of ['上级国家', '上级业务分类', '业务金额', '业务货币']) {
    await drawer.getByText(label, { exact: true }).waitFor();
  }
  await selectOption(page, '上级国家', fixture.countryName);
  await selectOption(page, '上级业务分类', fixture.categoryName);
  await formItem(page, '选项名称').locator('input').fill(`草稿 ${fixture.serviceName}`);
  assert.equal(await formItem(page, '业务货币').locator('input').inputValue(), 'USD');

  await navigateWithinV2(page, '/v2/orders');
  assert.equal(await page.locator('.el-drawer:visible').count(), 0, '离开页面后抽屉仍覆盖当前页面');
  await navigateWithinV2(page, '/v2/options');
  assert.equal(
    await page.locator('.el-drawer:visible').count(),
    0,
    '选项抽屉仍被 KeepAlive 意外恢复'
  );
}

async function readStorageKeys(page) {
  return page.evaluate(() => ({
    localStorageKeys: Object.keys(localStorage).sort(),
    sessionStorageKeys: Object.keys(sessionStorage).sort()
  }));
}

async function selectedOptionText(item) {
  return (await item.locator('.el-select__selected-item').allTextContents()).join(' ').trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
