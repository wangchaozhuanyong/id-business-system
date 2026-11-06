import { fileURLToPath, pathToFileURL } from 'node:url';
const playwright = await import(
  process.env.ID_RECHARGE_QA_PLAYWRIGHT
    ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href
    : 'playwright'
);
const { chromium } = playwright;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url)),
  output = path.join(root, '.runtime/tool-parity-20261107');
await mkdir(output, { recursive: true });
const origin = 'https://tool-layout.invalid';
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 901, 900, 390])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
        permissions: ['clipboard-read', 'clipboard-write']
      });
      const errors = [],
        blocked = [];
      let rows = 0,
        mailFailure = false;
      const mailRequests = [];
      const mailItems = Array.from({ length: 6 }, (_, i) => ({
        subject: '合成邮件 ' + i,
        from: 'sender@example.test',
        to: 'alias' + (i % 2) + '@example.test',
        virtualEmailId: 'alias-' + (i % 2),
        receivedAt: '2026-11-06T10:00:00Z',
        extractedCode: '123456',
        body: '<p>验证码 123456</p><script>window.mailInjected=true</script><img src="https://tracking.invalid/pixel"><a href="javascript:alert(1)">不可信链接</a><p><a href="https://example.test/verify">验证链接</a></p><p>详情 https://example.test/help。</p>'
      }));
      await context.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== origin) {
          blocked.push(u.origin);
          return route.abort();
        }
        const respond = (data) => route.fulfill({ json: data });
        if (u.pathname.startsWith('/api/')) {
          if (u.pathname === '/api/local/tools/mailbox-pool') {
            if (route.request().method() === 'PUT')
              return route.fulfill({ status: 422, json: { error: '合成授权验证失败，请重试' } });
            if (route.request().method() === 'POST')
              return respond({ code: 'SYNTHETIC-CODE-ONLY' });
            return respond({
              version: 0,
              defaultValidDays: 30,
              items: Array.from({ length: rows }, (_, i) => ({
                id: `fixture-${i}`,
                email: `合成验收-${i}@example.test`,
                provider: i === 1 ? 'microsoft' : 'google',
                label: '仅用于离线验收的长备注',
                active: true,
                expiresAt: '2099-01-01T00:00:00Z'
              }))
            });
          }
          if (u.pathname === '/api/local/tools/media/resolve')
            return respond({
              platform: 'douyin',
              mediaType: 'video',
              engine: 'f2',
              title: '合成解析验收：' + '长作品标题'.repeat(12),
              author: '离线合成作者',
              expiresAt: '2099-01-01T00:00:00Z',
              options: ['video', 'audio', 'image'].map((mediaType) => ({
                mediaType,
                label: '合成下载格式',
                extension: 'mp4',
                width: 1920,
                height: 1080,
                downloadToken: 'synthetic-only'
              }))
            });
          if (u.pathname === '/api/local/saved-totp') return respond({ version: 0, items: [] });
          if (u.pathname === '/api/local/toolbox')
            return respond({ version: 0, data: { shortcuts: [], phrases: [] } });
          if (
            u.pathname.endsWith('/mailbox-query') ||
            u.pathname.endsWith('/apple-relay/public-query')
          ) {
            mailRequests.push(route.request().postDataJSON());
            if (mailFailure)
              return route.fulfill({ status: 502, json: { error: '合成取信失败，请重试' } });
            return respond({
              targetType: u.pathname.endsWith('/public-query') ? 'VIRTUAL' : 'PRIMARY',
              primaryEmail: 'd***@example.test',
              codeExpiresAt: '2099-01-01T00:00:00Z',
              items: mailItems
            });
          }
          return respond({ version: 0, data: null });
        }
        let file = path.join(
          root,
          'frontend',
          u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)
        );
        if (u.pathname === '/assets/tools/totp.mjs')
          file = path.join(root, 'modules/tools/totp.mjs');
        let body;
        try {
          body = await readFile(file);
        } catch {
          return route.fulfill({ status: 404, body: 'Unavailable offline fixture asset' });
        }
        if (u.pathname === '/')
          body = body
            .toString()
            .replace(
              '<head>',
              `<head><meta name="id-local-auth" content="required"><meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify({ id: 'synthetic', name: '离线验收', role: 'admin' }))}">`
            )
            .replace('data-theme="light"', `data-theme="${theme}"`)
            .replace(
              '    <script src="./prototype.js',
              '    <script src="/local-data.js" defer></script><script src="/toolbox-local.js" defer></script>\n    <script src="./prototype.js'
            );
        return route.fulfill({
          body,
          contentType:
            {
              '.css': 'text/css',
              '.js': 'text/javascript',
              '.mjs': 'text/javascript',
              '.html': 'text/html'
            }[path.extname(file)] || 'application/octet-stream'
        });
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/overview');
      // Theme is a user preference, set through the actual visible control.
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.locator('#theme-toggle').click();
      await page.getByRole('button', { name: '工具箱', exact: true }).click();
      const drawer = page.locator('#drawer');
      await drawer.getByRole('tab', { name: '在线工具', exact: true }).click();
      for (const name of ['计算 2FA 验证码', '抖音解析', '邮箱查询与邮箱池']) {
        await drawer.locator('[data-action="tool-open"]').filter({ hasText: name }).click();
        if (name === '计算 2FA 验证码')
          await drawer.getByText('暂无已保存账号', { exact: true }).waitFor();
        const label = name === '计算 2FA 验证码' ? 'totp' : name === '抖音解析' ? 'media' : 'mail';
        const box = await drawer.boundingBox();
        const overflow = await drawer.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        assert(!overflow, `${width} ${theme} ${label} overflow`);
        assert(box.height < 650, `${label} unexpectedly tall: ${box.height}`);
        results.push({ viewportWidth: width, theme, tool: label, ...box, overflow });
        await page.screenshot({ path: path.join(output, `after-${label}-${width}-${theme}.png`) });
        if (name === '计算 2FA 验证码') {
          await drawer.locator('#ops-totp-secret').fill('JBSWY3DPEHPK3PXP');
          await drawer.locator('#ops-totp-secret').press('Enter');
          await drawer
            .locator('#ops-totp-result .ops-code')
            .filter({ hasText: /^\d{6}$/ })
            .waitFor();
          await drawer.getByRole('button', { name: '批量查询', exact: true }).click();
          await drawer
            .locator('#ops-totp-secret')
            .fill('JBSWY3DPEHPK3PXP\nJBSWY3DPEHPK3PXP\ninvalid!');
          await drawer.locator('#ops-totp-form button[type="submit"]').click();
          await drawer.locator('#ops-totp-result [data-totp-account]').nth(1).waitFor();
          assert.equal(await drawer.locator('#ops-totp-result [data-totp-account]').count(), 2);
        }
        if (name === '抖音解析') {
          await drawer
            .locator('#ops-media-text')
            .fill('https://www.douyin.com/video/synthetic-only');
          await drawer.getByRole('button', { name: '开始解析', exact: true }).click();
          await drawer.getByRole('button', { name: '下载原声', exact: true }).waitFor();
          assert.equal(
            await drawer.locator('#ops-media-result [data-action="ops-media-download"]').count(),
            3
          );
        }
        if (name === '邮箱查询与邮箱池') {
          await drawer.getByRole('button', { name: '查询邮件', exact: true }).click();
          assert(
            (await drawer.getByText('请输入邮箱查询码', { exact: false }).count()) ||
              (await drawer.locator('input:invalid').count())
          );
          await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
          await drawer.getByText('邮箱池暂无记录', { exact: true }).waitFor();
          await drawer.getByRole('button', { name: '登记邮箱', exact: true }).click();
          await page.locator('#ops-managed-email').fill('draft@example.test');
          {
            await drawer.getByRole('link', { name: '前往 Google 生成', exact: true }).waitFor();
            await page.locator('#ops-managed-provider').selectOption('apple');
            await drawer.getByRole('link', { name: '登录 Apple 账户生成', exact: true }).waitFor();
            await page.locator('#ops-managed-provider').selectOption('microsoft');
            assert(!(await page.locator('#ops-managed-app-password').isVisible()));
            await drawer
              .getByRole('button', { name: '连接 Microsoft 并添加', exact: true })
              .waitFor();
            await page.locator('#ops-managed-provider').selectOption('google');
            const heading = drawer
              .locator('.section-title-row')
              .filter({ has: page.getByRole('heading', { name: '添加邮箱', exact: true }) });
            const fieldBox = await page.locator('#ops-managed-email').boundingBox();
            await heading.locator('summary').click();
            assert.equal((await page.locator('#ops-managed-email').boundingBox()).y, fieldBox.y);
            await heading.locator('summary').press('Escape');
            assert(!(await heading.locator('details').getAttribute('open')));
          }
          await page.screenshot({ path: path.join(output, `after-pool-${width}-${theme}.png`) });
          await page.locator('#ops-managed-app-password').fill('synthetic-password');
          await drawer.getByRole('button', { name: '验证并添加', exact: true }).click();
          await page.getByText('合成授权验证失败，请重试', { exact: false }).waitFor();
          assert.equal(
            await page.locator('#ops-managed-app-password').inputValue(),
            'synthetic-password'
          );
          rows = 24;
          await drawer.getByRole('button', { name: '刷新', exact: true }).click();
          await drawer.getByText('合成验收-0@example.test', { exact: true }).waitFor();
          await drawer
            .locator('[data-mailbox-code]')
            .first()
            .filter({ hasText: 'SYNTHETIC-CODE-ONLY' })
            .waitFor();
          await drawer.getByRole('button', { name: '下一页', exact: true }).click();
          await drawer.getByText('合成验收-23@example.test', { exact: true }).waitFor();
          await drawer.getByRole('tab', { name: '邮件查询', exact: true }).click();
          assert((await drawer.boundingBox()).width <= 740);
          const query = drawer.locator('#ops-managed-mail-query');
          await query.locator('#ops-managed-query-code').fill('MBX-' + 'A'.repeat(32));
          await query.locator('#ops-managed-query-limit').fill('10');
          await query.getByRole('button', { name: '查询邮件', exact: true }).click();
          await query.getByText('共 6 封邮件', { exact: true }).waitFor();
          assert.equal(mailRequests.at(-1).limit, 10);
          assert.equal(await query.locator('a[href="https://example.test/verify"]').count(), 6);
          assert.equal(await query.locator('a[href^="javascript:"],img,script').count(), 0);
          assert.equal(await page.evaluate(() => window.mailInjected), undefined);
          await query.getByRole('button', { name: '一键复制', exact: true }).first().click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '123456');
          await query.getByRole('button', { name: '复制邮件正文', exact: true }).first().click();
          assert.match(await page.evaluate(() => navigator.clipboard.readText()), /验证码 123456/);
          await query.locator('#ops-mail-alias-filter').selectOption('alias-1');
          await query.getByText('共 3 封邮件', { exact: true }).waitFor();
          mailFailure = true;
          await query.getByRole('button', { name: '立即刷新', exact: true }).click();
          await query.getByText('合成取信失败，请重试', { exact: false }).waitFor();
          assert.equal(await query.locator('.guide-item').count(), 3);
          mailFailure = false;
          await query.getByRole('button', { name: '重试', exact: true }).click();
          await query.getByText('共 6 封邮件', { exact: true }).waitFor();
          await page.screenshot({
            path: path.join(output, `after-mail-result-${width}-${theme}.png`)
          });
          await query.locator('#ops-managed-query-code').fill('BUY-SYNTHETIC');
          await query.getByRole('button', { name: '查询邮件', exact: true }).click();
          await query.getByText('共 5 封邮件', { exact: true }).waitFor();
          await query.getByText('仅展示该虚拟邮箱最近 5 封邮件。', { exact: true }).waitFor();
          await query.getByRole('button', { name: '清空', exact: true }).click();
          assert.equal(await query.locator('#ops-managed-query-limit').inputValue(), '5');
          assert.equal(await query.locator('#ops-managed-query-code').inputValue(), '');
          assert.equal(await query.locator('#ops-managed-query-results').innerText(), '');
          await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
          assert.equal(await page.locator('#ops-managed-email').inputValue(), 'draft@example.test');
        }
        const populated = await drawer.boundingBox();
        assert(populated.height <= 876, `${label} does not constrain populated content`);
        assert(
          !(await drawer.evaluate((el) => el.scrollWidth > el.clientWidth + 1)),
          `${label} populated overflow`
        );
        const labelsLeft = await drawer.locator('.field:visible').evaluateAll((nodes) =>
          nodes.every((node) => {
            const label = node.querySelector(':scope > label'),
              control = node.querySelector(':scope > .field-control');
            return (
              !label ||
              !control ||
              label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1
            );
          })
        );
        assert(labelsLeft, `${width} ${theme} ${label}: field labels moved above controls`);
        if (name !== '邮箱查询与邮箱池')
          await page.screenshot({
            path: path.join(output, `after-${label}-result-${width}-${theme}.png`)
          });
        await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      }
      // Opening a different drawer must not inherit the compact tool geometry.
      await page.evaluate(() =>
        window.IDDesignAPI.openDrawer(
          '普通详情',
          '',
          window.IDDesignAPI.field(
            '测试字段',
            'layout-fixture',
            window.IDDesignAPI.input('layout-fixture')
          )
        )
      );
      assert.equal(await drawer.getAttribute('data-tool'), '');
      assert.equal(await drawer.getAttribute('data-section'), '');
      assert((await drawer.boundingBox()).height >= 899);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      await context.close();
    }
  await writeFile(path.join(output, `after-geometry.json`), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({
      mode: 'after',
      scenarios: results.length,
      network: 'fully intercepted; no server or database'
    })
  );
} finally {
  await browser.close();
}
