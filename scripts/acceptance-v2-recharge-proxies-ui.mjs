#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://proxy-pool.acceptance.invalid';
const distribution = path.join(root, 'apps/admin/dist');
const outputDir = path.join(root, '.runtime/shared-proxy-pool-ui');
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--dark-narrow'),
  '未知页面验收选项'
);
const darkNarrow = process.argv.includes('--dark-narrow');
const themes = darkNarrow ? ['dark'] : ['light', 'dark'];
const widths = darkNarrow ? [768, 390] : [1440, 1024, 901, 900, 768, 390];
const now = '2026-09-30T12:00:00.000Z';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'proxy-acceptance',
  displayName: '代理验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const rows = Array.from({ length: 21 }, (_, index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
  countryCode: index === 20 ? 'PH' : 'US',
  kind: index === 20 ? 'mobile' : 'dynamic_residential',
  connectionMode: 'extraction',
  protocol: 'http',
  linkMask: `已保存 ···${String(index).padStart(6, '0')}`,
  status: 'active',
  remark1: index === 20 ? '最后一页代理' : `测试代理 ${index + 1}`,
  remark2: '',
  remark: index === 20 ? '最后一页代理' : `测试代理 ${index + 1}`,
  exitIp: '8.8.8.8',
  latencyMs: 25,
  testMessage: '检测成功',
  testedAt: now,
  createdAt: now,
  updatedAt: now
}));
const initialRows = structuredClone(rows);
const mutations = [];
async function assertFormAlignment(form, state) {
  const rows = await form.locator('.el-form-item').evaluateAll((items) =>
    items.flatMap((item) => {
      const label = item.querySelector('.el-form-item__label');
      const control = item.querySelector('.el-input__wrapper, .el-select__wrapper');
      if (!label || !control) return [];
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const box = control.getBoundingClientRect();
      return [
        {
          left: text.left,
          right: text.right,
          controlLeft: box.left,
          delta: Math.abs((text.top + text.bottom) / 2 - (box.top + box.bottom) / 2)
        }
      ];
    })
  );
  assert.ok(rows.length >= 4, `${state} 缺少实际表单控件`);
  for (const row of rows) {
    assert.ok(row.right <= row.controlLeft + 1, `${state} 标签未在控件左侧`);
    assert.ok(row.delta <= 5, `${state} 标签文字未对齐首行控件`);
  }
}
async function assertListLayout(page, state) {
  const geometry = await page
    .locator('.v2-records-list')
    .first()
    .evaluate((list) => {
      const header = list.querySelector(':scope > header');
      const title = header?.querySelector('.v2-section-heading__title');
      const count = header?.querySelector('.v2-section-heading__actions span');
      if (!header || !title) return null;
      const outer = list.getBoundingClientRect();
      const frame = header.getBoundingClientRect();
      const text = title.getBoundingClientRect();
      const countBox = count?.getBoundingClientRect();
      return {
        outerLeft: outer.left,
        outerRight: outer.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        titleLeft: text.left,
        titleTop: text.top,
        titleBottom: text.bottom,
        frameTop: frame.top,
        frameBottom: frame.bottom,
        overlap: countBox
          ? text.right > countBox.left && text.top < countBox.bottom && countBox.top < text.bottom
          : false
      };
    });
  assert.ok(geometry, `${state} 缺少表格标题`);
  assert.ok(
    geometry.frameLeft >= geometry.outerLeft - 1 && geometry.frameRight <= geometry.outerRight + 1,
    `${state} 标题框超出列表`
  );
  assert.ok(
    geometry.titleLeft > geometry.frameLeft &&
      geometry.titleTop >= geometry.frameTop &&
      geometry.titleBottom <= geometry.frameBottom,
    `${state} 标题文字未对齐`
  );
  assert.equal(geometry.overlap, false, `${state} 标题与数量重叠`);
}
mkdirSync(outputDir, { recursive: true });
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端再运行离线页面验收');
let browser;
let inspectedPage;
let requestFailures;
try {
  browser = await chromium.launch({ headless: true });
  for (const theme of themes)
    for (const width of widths) {
      rows.splice(0, rows.length, ...structuredClone(initialRows));
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      inspectedPage = page;
      page.setDefaultTimeout(30000);
      const errors = [];
      const unexpected = [];
      requestFailures = unexpected;
      let detectionTasks = [];
      let detectionStatus = 'queued';
      let detectionPosts = 0;
      page.on('pageerror', (error) => errors.push(error.message));
      // The actual production build runs in Chromium with intercepted resources.
      // No website, API, database, or local HTTP listener is started.
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          unexpected.push(`external ${url.origin}`);
          await route.abort();
          return;
        }
        const relative = url.pathname.startsWith('/v2/') ? '/index.html' : url.pathname;
        const asset = path.resolve(distribution, `.${relative}`);
        if (!asset.startsWith(`${distribution}${path.sep}`) || !existsSync(asset)) {
          unexpected.push(`asset ${url.pathname}`);
          await route.fulfill({ status: 404, body: '' });
          return;
        }
        const contentType =
          {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.woff2': 'font/woff2'
          }[path.extname(asset)] || 'application/octet-stream';
        await route.fulfill({ status: 200, contentType, body: readFileSync(asset) });
      });
      await page.addInitScript((fixture) => {
        localStorage.setItem('apple_business_access_token', 'proxy-acceptance-token');
        localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
      }, user);
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = url.pathname;
        const method = request.method();
        if (endpoint === '/api/realtime/events') {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: 'retry: 60000\n: offline fixture\n\n'
          });
          return;
        }
        if (!endpoint.startsWith('/api/')) {
          await route.continue();
          return;
        }
        let data;
        if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) data = user;
        else if (endpoint.endsWith('/id-business-v2/branding/public'))
          data = {
            appName: 'ID 业务管理',
            logoText: 'ID',
            logoUrl: '/brand/default-logo.svg',
            appSubtitle: '业务管理',
            documentTitleSuffix: 'ID 业务管理'
          };
        else if (endpoint.endsWith('/id-business-v2/time'))
          data = { now, timezone: 'Asia/Shanghai' };
        else if (endpoint.endsWith('/id-business-v2/change-versions'))
          data = { generatedAt: now, versions: {} };
        else if (endpoint.endsWith('/id-business-v2/table-preferences')) data = { items: [] };
        else if (endpoint.endsWith('/id-business-v2/quick-actions'))
          data = { items: [], updatedAt: now };
        else if (endpoint.endsWith('/id-business-v2/workspace-shortcuts')) data = { items: [] };
        else if (endpoint.endsWith('/id-business-v2/renewals/warning-summary'))
          data = {
            warningDays: 3,
            defaultWarningDays: 3,
            upcomingCount: 0,
            expiredCount: 0,
            totalCount: 0,
            evaluatedAt: now,
            revalidateAt: now
          };
        else if (endpoint.endsWith('/id-business-v2/bank-recharge/renewal-warnings'))
          data = {
            warningDays: 3,
            upcomingCount: 0,
            expiredCount: 0,
            totalCount: 0,
            items: [],
            evaluatedAt: now,
            revalidateAt: now
          };
        else if (endpoint.endsWith('/id-business-v2/sensitive-access/approvals/summary'))
          data = { pendingCount: 0, items: [], generatedAt: now };
        else if (endpoint.endsWith('/online-recharge/admin/jobs')) {
          const items = detectionTasks.map((task) => ({
            ...task,
            status: detectionStatus,
            progress: detectionStatus === 'running' ? 50 : detectionStatus === 'queued' ? 0 : 100,
            message:
              detectionStatus === 'failed'
                ? '代理认证失败，请检查账号和密码'
                : detectionStatus === 'succeeded'
                  ? '检测成功'
                  : '检测任务',
            updatedAt: new Date().toISOString()
          }));
          data = {
            items,
            total: items.length,
            page: 1,
            pageSize: 100,
            revalidateAt: items.some((task) => ['queued', 'running'].includes(task.status))
              ? new Date(Date.now() + 150).toISOString()
              : null
          };
        } else if (endpoint.endsWith('/online-recharge/admin/proxies/test')) {
          detectionPosts++;
          const requestInput = request.postDataJSON();
          const selected =
            requestInput.ids || (requestInput.id ? [requestInput.id] : rows.map((row) => row.id));
          detectionStatus = 'queued';
          detectionTasks = selected.map((proxyId, index) => ({
            id: `88888888-8888-4888-8888-${String(detectionPosts * 100 + index + 1).padStart(12, '0')}`,
            proxyId,
            status: 'queued',
            progress: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            message: '等待执行'
          }));
          data = { tasks: detectionTasks, reused: 0 };
        } else if (endpoint.endsWith('/proxy-pool/countries')) data = { items: ['US', 'PH'] };
        else if (endpoint.endsWith('/proxy-pool/import') && method === 'POST') {
          const input = request.postDataJSON();
          assert.equal(input.proxies.length, 1);
          mutations.push({ method, endpoint, input });
          rows.unshift({
            ...rows[0],
            id: '66666666-6666-4666-8666-666666666666',
            countryCode: input.proxies[0].countryCode,
            kind: input.proxies[0].kind,
            protocol: input.proxies[0].protocol ?? 'http',
            remark1: input.proxies[0].remark,
            remark: input.proxies[0].remark
          });
          data = { imported: 1 };
        } else if (endpoint.endsWith('/proxy-pool') && method === 'POST') {
          const input = request.postDataJSON();
          mutations.push({ method, endpoint, input });
          rows.unshift({
            ...rows[0],
            id: '77777777-7777-4777-8777-777777777777',
            countryCode: input.countryCode,
            kind: input.kind,
            protocol: input.protocol,
            connectionMode: input.connectionMode,
            remark1: input.remark,
            remark: input.remark
          });
          data = { id: rows[0].id };
        } else if (endpoint.endsWith('/proxy-pool') && method === 'GET') {
          const filtered = rows.filter(
            (item) =>
              (!url.searchParams.get('keyword') ||
                `${item.countryCode} ${item.remark1}`.includes(url.searchParams.get('keyword'))) &&
              (!url.searchParams.get('countryCode') ||
                item.countryCode === url.searchParams.get('countryCode')) &&
              (!url.searchParams.get('kind') || item.kind === url.searchParams.get('kind')) &&
              (!url.searchParams.get('status') || item.status === url.searchParams.get('status'))
          );
          const pageNumber = Number(url.searchParams.get('page') || 1);
          const pageSize = Number(url.searchParams.get('pageSize') || 20);
          data = {
            items: filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
            total: filtered.length,
            page: pageNumber,
            pageSize
          };
        } else if (/\/proxy-pool\/[^/]+$/.test(endpoint)) {
          const id = endpoint.split('/').at(-1);
          const item = rows.find((row) => row.id === id);
          assert.ok(item, `未知代理 ${id}`);
          if (method === 'GET')
            data = { ...item, url: 'https://proxy.example.invalid/get?token=synthetic' };
          else if (method === 'PATCH') {
            const input = request.postDataJSON();
            mutations.push({ method, endpoint, input });
            const connectionChanged =
              (input.protocol && input.protocol !== item.protocol) ||
              (input.connectionMode && input.connectionMode !== item.connectionMode) ||
              Boolean(input.url);
            Object.assign(item, input);
            if (connectionChanged) {
              Object.assign(item, {
                exitIp: null,
                latencyMs: null,
                testMessage: null,
                testedAt: null
              });
              for (const task of detectionTasks)
                if (task.proxyId === id) task.connectionChanged = true;
            }
            data = { id };
          } else if (method === 'DELETE') {
            mutations.push({ method, endpoint });
            rows.splice(rows.indexOf(item), 1);
            data = { id };
          }
        }
        if (data === undefined) {
          unexpected.push(`${method} ${endpoint}`);
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, message: 'Unexpected acceptance request' })
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data,
              message: 'OK',
              requestId: 'proxy-acceptance',
              timestamp: now
            })
          });
        }
      });
      await page.goto(`${origin}/v2/auto-recharge/proxies`, { waitUntil: 'domcontentloaded' });
      try {
        await page
          .getByText('测试代理 1', { exact: true })
          .waitFor({ state: 'visible', timeout: 12000 });
      } catch (cause) {
        await page.screenshot({
          path: path.join(outputDir, `${theme}-${width}-debug.png`),
          fullPage: true
        });
        throw new Error(
          `代理页未加载：${page.url()}；请求=${unexpected.join(', ')}；错误=${errors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(0, 900)}`,
          { cause }
        );
      }
      assert.equal(new URL(page.url()).pathname, '/v2/account-settings/proxies');
      await page.evaluate((value) => {
        const root = document.documentElement;
        root.setAttribute('data-v2-theme', value);
        root.classList.toggle('dark', value === 'dark');
        root.style.colorScheme = value;
      }, theme);
      await assertListLayout(page, `${width}px 首页`);
      await page.screenshot({
        path: path.join(outputDir, `${theme}-${width}-first.png`),
        fullPage: true
      });
      await page.getByRole('button', { name: '下一页' }).click();
      await page.getByText('最后一页代理').waitFor({ state: 'visible' });
      await assertListLayout(page, `${width}px 末页`);
      await page.screenshot({
        path: path.join(outputDir, `${theme}-${width}-last.png`),
        fullPage: true
      });
      await page.getByRole('button', { name: '上一页' }).click();
      const first = page
        .locator('.v2-records-table tbody tr')
        .filter({ hasText: '测试代理 1' })
        .first();
      await first.getByRole('button', { name: '详细' }).click();
      await page
        .getByText('https://proxy.example.invalid/get?token=synthetic')
        .waitFor({ state: 'visible' });
      await page
        .getByLabel('代理 IP 详细')
        .getByRole('button', { name: 'Close' })
        .click()
        .catch(async () => {
          await page.keyboard.press('Escape');
        });
      await first.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
      const editor = page
        .locator('.v2-form-drawer')
        .filter({ has: page.getByRole('heading', { name: '编辑代理', exact: true }) });
      await editor
        .locator('.el-select')
        .filter({ has: page.getByRole('combobox', { name: '代理协议', exact: true }) })
        .click();
      await page.getByRole('option', { name: 'SOCKS5', exact: true }).click();
      await page.screenshot({
        path: path.join(outputDir, `${theme}-${width}-protocol-editor.png`),
        fullPage: true
      });
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await first.getByText('SOCKS5', { exact: true }).waitFor();
      assert.ok(
        mutations.some((entry) => entry.method === 'PATCH' && entry.input.protocol === 'socks5')
      );
      await page.getByRole('button', { name: '新增代理', exact: true }).click();
      const creator = page
        .locator('.v2-form-drawer')
        .filter({ has: page.getByRole('heading', { name: '新增代理', exact: true }) });
      for (const [name, label] of [
        ['代理国家', '菲律宾'],
        ['代理属性', '动态住宅'],
        ['代理连接方式', '代理地址（支持动态会话）'],
        ['代理协议', 'SOCKS5']
      ]) {
        await creator
          .locator('.el-select')
          .filter({ has: page.getByRole('combobox', { name, exact: true }) })
          .click();
        await page.getByRole('option', { name: label, exact: true }).click();
      }
      const addressInput = creator.getByPlaceholder('主机:端口:账号:密码，或标准代理链接');
      const beforeInvalid = mutations.length;
      await addressInput.fill('invalid-address');
      await creator.getByRole('button', { name: '保存', exact: true }).click();
      await creator.locator('.el-form-item__error').first().waitFor();
      await assertFormAlignment(creator, `${theme}-${width} 保存格式错误`);
      assert.equal(mutations.length, beforeInvalid, '格式错误不应发送保存请求');
      await addressInput.fill('gateway.example.test:1080:review:p@ss:word');
      await creator.getByRole('button', { name: '保存', exact: true }).click();
      await creator.waitFor({ state: 'hidden' });
      assert.ok(
        mutations.some(
          (entry) =>
            entry.method === 'POST' &&
            entry.input.url === 'socks5://review:p%40ss%3Aword@gateway.example.test:1080' &&
            entry.input.protocol === 'socks5'
        ),
        '供应商格式应规范化后保存'
      );
      await first.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '检测连通性' }).click();
      await page.getByText('已提交 1 个检测任务，结果将自动更新', { exact: true }).waitFor();
      await first.getByText(/等待执行/).waitFor();
      assert.equal(
        await page.getByRole('button', { name: '检测启用代理', exact: true }).isDisabled(),
        true
      );
      detectionTasks[0].createdAt = new Date(Date.now() - 121000).toISOString();
      await first.getByText(/排队超过 2 分钟/).waitFor();
      detectionStatus = 'running';
      await first.getByText(/检测中（50%）/).waitFor();
      assert.equal(detectionPosts, 1, '等待执行期间不得重复排队');
      detectionStatus = 'failed';
      await first.getByText('代理认证失败，请检查账号和密码', { exact: true }).waitFor();
      await first.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '重试检测' }).click();
      await first.getByText(/等待执行/).waitFor();
      assert.equal(detectionPosts, 2, '失败后允许明确重试');
      const detected = rows.find((row) => row.id === detectionTasks[0].proxyId);
      Object.assign(detected, {
        exitIp: '1.1.1.1',
        latencyMs: 36,
        testMessage: '检测成功',
        testedAt: new Date().toISOString()
      });
      detectionStatus = 'succeeded';
      await first.getByText('1.1.1.1', { exact: true }).waitFor();
      await first.getByText('检测成功', { exact: true }).waitFor();
      await page.locator('.el-message--warning').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: path.join(outputDir, `${theme}-${width}-detection-result.png`),
        fullPage: true
      });
      await first.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
      await editor
        .locator('.el-select')
        .filter({ has: page.getByRole('combobox', { name: '代理协议', exact: true }) })
        .click();
      await page.getByRole('option', { name: 'HTTP', exact: true }).click();
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await first.getByText('连接资料已修改，请重新检测', { exact: true }).waitFor();
      assert.equal(
        await first.getByText('检测成功', { exact: true }).count(),
        0,
        '新连接不得显示旧成功'
      );
      assert.equal(
        await first.getByText('1.1.1.1', { exact: true }).count(),
        0,
        '新连接不得保留旧出口'
      );
      await page.getByRole('button', { name: '批量导入' }).click();
      const importer = page
        .locator('.v2-form-drawer')
        .filter({ has: page.getByRole('heading', { name: '批量导入代理', exact: true }) });
      for (const [name, label] of [
        ['代理国家', '菲律宾'],
        ['代理属性', '移动代理'],
        ['代理连接方式', 'HTTPS 提取链接'],
        ['代理协议', 'HTTPS']
      ]) {
        await importer
          .locator('.el-select')
          .filter({ has: page.getByRole('combobox', { name, exact: true }) })
          .click();
        await page.getByRole('option', { name: label, exact: true }).click();
      }
      await importer
        .locator('.el-form-item')
        .filter({ hasText: '备注' })
        .getByRole('textbox')
        .fill('导入验收');
      const importInput = importer.getByPlaceholder('每行一条代理地址或提取链接，最多 500 条');
      const beforeInvalidImport = mutations.length;
      await importInput.fill('https://proxy.example.invalid/another\ninvalid-second-line');
      await importer.getByRole('button', { name: '导入代理', exact: true }).click();
      await importer.locator('.el-form-item__error').filter({ hasText: '第 2 行' }).waitFor();
      await assertFormAlignment(importer, `${theme}-${width} 导入行号错误`);
      assert.equal(mutations.length, beforeInvalidImport, '导入校验失败应整批不写入');
      await importInput.fill('https://proxy.example.invalid/another');
      await importer.getByRole('button', { name: '导入代理', exact: true }).click();
      await importer.getByText('已导入 1 条，跳过重复 0 条').waitFor();
      await importer.locator('.el-form-item__error').waitFor({ state: 'hidden' });
      assert.equal(
        await importer.locator('.el-form-item__error:visible').count(),
        0,
        '成功导入后清除输入不应显示必填错误'
      );
      await importer.getByRole('button', { name: '关闭', exact: true }).click();
      await importer.waitFor({ state: 'hidden' });
      await page.getByText('导入验收').first().waitFor({ state: 'visible' });
      await page.getByPlaceholder('代理地址、国家代码或备注').fill('不存在');
      await page.getByRole('button', { name: '查询', exact: true }).click();
      await page.getByPlaceholder('代理地址、国家代码或备注').press('Enter');
      try {
        await page.getByText('暂无代理', { exact: true }).waitFor({ state: 'visible' });
      } catch (cause) {
        await page.screenshot({
          path: path.join(outputDir, `${theme}-${width}-search-debug.png`),
          fullPage: true
        });
        throw new Error(
          `代理空状态未显示：${width}px；请求=${unexpected.join(', ')}；错误=${errors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(-900)}`,
          { cause }
        );
      }
      await assertListLayout(page, `${width}px 空状态`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
      );
      assert.equal(overflow, false, `${width}px 页面横向溢出`);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: path.join(outputDir, `${theme}-${width}-empty.png`),
        fullPage: true
      });
      await context.close();
    }
  assert.ok(mutations.some((entry) => entry.endpoint.endsWith('/import')));
  assert.ok(
    mutations.some(
      (entry) => entry.endpoint.endsWith('/import') && entry.input.proxies[0].protocol === 'https'
    )
  );
  const report = {
    ok: true,
    mode: 'OFFLINE_BUILT_ADMIN_WITH_SYNTHETIC_API',
    localWebsiteStarted: false,
    productionMutated: false,
    widths,
    themes,
    states: [
      'legacy-redirect',
      'first',
      'last',
      'detail',
      'protocol-edit',
      'supplier-format-invalid-and-save',
      'detection-queue',
      'detection-overdue-without-false-failure',
      'detection-running',
      'detection-failure-and-retry',
      'detection-result-refresh',
      'connection-change-invalidates-old-success',
      'import-protocol',
      'import-line-error',
      'empty'
    ],
    outputDir
  };
  writeFileSync(
    path.join(outputDir, darkNarrow ? 'repair-result-dark-narrow.json' : 'repair-result.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report));
} catch (error) {
  if (inspectedPage && !inspectedPage.isClosed()) {
    await inspectedPage.screenshot({
      path: path.join(outputDir, 'repair-failure.png'),
      fullPage: true
    });
    writeFileSync(
      path.join(outputDir, 'repair-failure-body.txt'),
      await inspectedPage.locator('body').innerText()
    );
    writeFileSync(
      path.join(outputDir, 'repair-failure-requests.json'),
      JSON.stringify(requestFailures)
    );
  }
  throw error;
} finally {
  await browser?.close();
}
