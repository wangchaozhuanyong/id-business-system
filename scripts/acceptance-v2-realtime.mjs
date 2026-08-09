#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const adminBaseUrl = String(
  process.env.V2_REALTIME_ADMIN_BASE_URL ?? 'http://127.0.0.1:5374'
).replace(/\/$/, '');
const databaseUrl =
  process.env.V2_REALTIME_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?schema=public';
const username = process.env.V2_REALTIME_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
const password = process.env.V2_REALTIME_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
const allowRemote = process.env.V2_REALTIME_ALLOW_REMOTE === 'true';
const timeoutMs = 30_000;

assert.ok(
  username && password,
  '缺少 V2_REALTIME_USERNAME/V2_REALTIME_PASSWORD 或 seed 管理员账号'
);
assertLocalTarget(adminBaseUrl, '管理端');
assertLocalTarget(databaseUrl, '数据库');

const health = await fetch(adminBaseUrl, {
  signal: AbortSignal.timeout(5_000)
}).catch(() => null);
assert.ok(health?.ok, `本地 V2 管理端不可用：${adminBaseUrl}`);

const database = new Client({ connectionString: databaseUrl });
await database.connect();
const realtimeAvailable = await database.query(
  `SELECT to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL AS available`
);
assert.equal(
  realtimeAvailable.rows[0]?.available,
  true,
  '本地 Supabase Realtime 未启动或 realtime.send() 不可用'
);

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requests = {
    orders: 0,
    customers: 0,
    versions: 0
  };
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.endsWith('/api/id-business-v2/orders') ||
      pathname.endsWith('/api/id-business-v2/orders/bootstrap')
    ) {
      requests.orders += 1;
    }
    if (
      pathname.endsWith('/api/id-business-v2/customers') ||
      pathname.endsWith('/api/id-business-v2/customers/bootstrap')
    ) {
      requests.customers += 1;
    }
    if (pathname.endsWith('/api/id-business-v2/change-versions')) {
      requests.versions += 1;
    }
  });

  await login(page);
  await navigate(page, '/v2/orders');
  const ordersBeforeActiveChange = requests.orders;
  await publishChange(['orders']);
  await waitForCount(() => requests.orders, ordersBeforeActiveChange);
  assert.ok(requests.orders > ordersBeforeActiveChange, '当前订单页收到 Broadcast 后没有后台刷新');

  await navigate(page, '/v2/customers');
  const customersBeforeInactiveChange = requests.customers;
  await navigate(page, '/v2/orders');
  await publishChange(['customers']);
  await page.waitForTimeout(500);
  assert.equal(
    requests.customers,
    customersBeforeInactiveChange,
    '非当前客户页收到 Broadcast 后提前读取了业务列表'
  );
  await navigate(page, '/v2/customers');
  assert.equal(
    requests.customers,
    customersBeforeInactiveChange + 1,
    'dirty 客户页进入时没有刷新一次'
  );

  const versionsBeforeOffline = requests.versions;
  const ordersBeforeOffline = requests.orders;
  await context.setOffline(true);
  await publishChange(['orders']);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForCount(() => requests.versions, versionsBeforeOffline);
  assert.equal(
    requests.orders,
    ordersBeforeOffline,
    '恢复联网后的版本补偿提前读取了非当前订单列表'
  );
  await navigate(page, '/v2/orders');
  assert.equal(requests.orders, ordersBeforeOffline + 1, '漏事件补偿没有把订单 scope 标记为 dirty');

  await navigate(page, '/v2/workbench/order-entry');
  const draftInput = page.locator('input[placeholder="选填"]').first();
  await draftInput.fill('realtime-draft-must-survive');
  await publishChange(['orders']);
  await page.waitForTimeout(500);
  assert.equal(
    await draftInput.inputValue(),
    'realtime-draft-must-survive',
    '实时列表刷新覆盖了未提交订单草稿'
  );

  console.log(
    JSON.stringify({
      ok: true,
      activeScopeRefresh: true,
      inactiveScopeDirtyOnly: true,
      offlineVersionRecovery: true,
      draftRetention: true,
      topic: 'id-business-v2:changes'
    })
  );
} finally {
  await browser.close();
  await database.end();
}

function assertLocalTarget(value, label) {
  if (allowRemote) return;
  const hostname = new URL(value).hostname;
  assert.ok(
    hostname === '127.0.0.1' || hostname === 'localhost',
    `${label}不是本地地址；如确需远程验收，必须显式设置 V2_REALTIME_ALLOW_REMOTE=true`
  );
}

async function login(page) {
  await page.goto(`${adminBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#v2-admin-login-form').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('[name="username"]').fill(username);
  await page.locator('[name="password"]').fill(password);
  await page.locator('#v2-admin-login-form button[type="submit"]').click();
  await page.waitForURL('**/v2/**', { timeout: timeoutMs });
  await page.locator('.v2-shell').waitFor({ state: 'visible', timeout: timeoutMs });
}

async function navigate(page, path) {
  if (new URL(page.url()).pathname !== path) {
    await page
      .locator(`a[href="${path}"]`)
      .first()
      .evaluate((element) => element.click());
    await page.waitForURL(`**${path}`, { timeout: timeoutMs });
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('#v2-main [aria-busy]')].every(
        (element) => element.getAttribute('aria-busy') !== 'true'
      ),
    undefined,
    { timeout: timeoutMs }
  );
}

async function waitForCount(readCount, previousCount) {
  const startedAt = Date.now();
  while (readCount() <= previousCount) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待请求计数超过 ${previousCount} 超时`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function publishChange(scopes) {
  await database.query('BEGIN');
  try {
    const result = await database.query(
      `
        WITH requested(scope) AS (
          SELECT DISTINCT unnest($1::text[])
        ),
        bumped AS (
          INSERT INTO public.id_business_v2_scope_versions AS current_version (
            scope,
            version,
            updated_at
          )
          SELECT requested.scope, 1, transaction_timestamp()
          FROM requested
          ON CONFLICT (scope) DO UPDATE
            SET version = current_version.version + 1,
                updated_at = transaction_timestamp()
          RETURNING scope, version
        )
        SELECT scope, version::text AS version
        FROM bumped
        ORDER BY scope
      `,
      [scopes]
    );
    const payload = {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      scopes: result.rows
    };
    await database.query(
      `SELECT realtime.send($1::jsonb, 'change', 'id-business-v2:changes', true)`,
      [JSON.stringify(payload)]
    );
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
}
