import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { chromium } from 'playwright';

// Compiles a synthetic frontend fixture and serves it through browser request interception.
// No local web/API server or database is started; all mailbox APIs are in-memory doubles.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(root, '.runtime/mailbox-query-code-validity-20261027');
const outDir = join(evidence, 'browser-build');
await mkdir(evidence, { recursive: true });
if (!process.argv.includes('--reuse-build'))
  await build({
    configFile: false,
    root: join(root, 'apps/admin'),
    logLevel: 'error',
    define: { __V2_BUILD_ID__: JSON.stringify('mailbox-expiry-fixture') },
    resolve: { alias: { '@': join(root, 'apps/admin/src') } },
    plugins: [
      AutoImport({
        dts: false,
        imports: ['vue', 'vue-router', 'pinia'],
        resolvers: [ElementPlusResolver({ importStyle: 'css' })]
      }),
      Components({ dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] }),
      vue()
    ],
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: { input: join(root, 'apps/admin/mailbox-query-code-validity-fixture.html') }
    }
  });
const browser = await chromium.launch({ headless: true });
const results = [];
let activePage;
let activeErrors = [];
let activeUnexpectedRequests = [];
try {
  for (const system of ['managed', 'vendure']) {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();
    activePage = page;
    const errors = [];
    const unexpectedRequests = [];
    activeErrors = errors;
    activeUnexpectedRequests = unexpectedRequests;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mailbox-expiry.test' || url.pathname.startsWith('/api')) {
        unexpectedRequests.push(url.pathname);
        await route.abort();
        return;
      }
      try {
        const file = join(outDir, decodeURIComponent(url.pathname));
        const mime =
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml'
          }[extname(file)] ?? 'application/octet-stream';
        await route.fulfill({ body: await readFile(file), contentType: mime });
      } catch {
        await route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto(
      `https://mailbox-expiry.test/mailbox-query-code-validity-fixture.html?system=${system}`
    );
    if (system === 'vendure')
      await page.getByRole('tab', { name: '虚拟邮箱管理', exact: true }).click();
    const menus = () => page.locator('button:visible').filter({ hasText: /更多操作/ });
    const openReset = async (index = 0) => {
      await menus().nth(index).click();
      await page.getByRole('menuitem', { name: /重置.*查询码/ }).click();
      await page.getByRole('dialog', { name: '重置查询码', exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          !globalThis.document.querySelector('.dialog-fade-enter-active, .dialog-fade-leave-active')
      );
    };
    const dialog = () => page.getByRole('dialog', { name: '重置查询码', exact: true });
    const choose = async (label) => {
      await dialog().locator('.el-select').click();
      await page.getByRole('option', { name: label, exact: true }).click();
      await dialog().locator('.el-select__selected-item').filter({ hasText: label }).waitFor();
    };
    const control = (values) =>
      page.evaluate(
        (input) => Object.assign(globalThis.window.mailboxExpiryFixture, input),
        values
      );
    const writes = () => page.evaluate(() => globalThis.window.mailboxExpiryFixture.writes);
    if (system === 'managed') {
      await page.getByRole('button', { name: '有效期设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '查询码有效期设置', exact: true });
      await settings
        .locator('.el-select__selected-item')
        .filter({ hasText: '3个月（90天）' })
        .waitFor();
      assert.equal(await settings.getByRole('checkbox').isChecked(), false);
      await settings.getByRole('button', { name: '取消', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
      assert.equal(await page.getByText('关闭后会放弃尚未保存的有效期设置。').count(), 0);
      assert.equal((await writes()).length, 0);
      results.push({ system, scenario: 'server-default-first-open-clean-cancel', passed: true });
    }
    await openReset();
    await choose('半年（180天）');
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await openReset();
    assert.ok(
      await dialog().locator('.el-select__selected-item').filter({ hasText: '半年' }).count()
    );
    assert.equal((await writes()).length, 0);
    // Review the actual shared modal at both themes and the project breakpoints.
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 1024, 901, 900, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate((value) => {
          globalThis.document.documentElement.dataset.v2Theme = value;
        }, theme);
        const dimensions = await dialog().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const item = [...element.querySelectorAll('.el-form-item')].find((row) =>
            row.textContent.includes('新码有效期')
          );
          const label = item.querySelector('label').getBoundingClientRect();
          const input = item.querySelector('.el-select').getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: globalThis.innerWidth,
            overflow: element.scrollWidth - element.clientWidth,
            labelRight: label.right,
            inputLeft: input.left,
            labelTop: label.top,
            inputBottom: input.bottom
          };
        });
        assert.ok(
          dimensions.left >= -1 && dimensions.right <= width + 1,
          JSON.stringify(dimensions)
        );
        assert.ok(dimensions.overflow <= 1, JSON.stringify(dimensions));
        assert.ok(
          dimensions.labelRight <= dimensions.inputLeft + 1 &&
            dimensions.labelTop < dimensions.inputBottom,
          JSON.stringify(dimensions)
        );
        results.push({ system, theme, width, scenario: 'dialog-layout', passed: true });
        if ((theme === 'light' && width === 1440) || (theme === 'dark' && width === 390)) {
          await page.screenshot({ path: join(evidence, `${system}-${theme}-${width}.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await openReset(1);
    assert.ok(
      await dialog().locator('.el-select__selected-item').filter({ hasText: '3个月' }).count()
    );
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await openReset();
    await choose('1年（365天）');
    await control({ failWrite: true });
    await dialog().getByRole('button', { name: '确认重置', exact: true }).click();
    await dialog().getByRole('alert').filter({ hasText: '模拟重置失败' }).waitFor();
    assert.ok(
      await dialog().locator('.el-select__selected-item').filter({ hasText: '1年' }).count()
    );
    await control({ failWrite: false, delayMs: 300 });
    await dialog()
      .getByRole('button', { name: '确认重置', exact: true })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    assert.ok(await dialog().getByRole('button', { name: '确认重置', exact: true }).isDisabled());
    await dialog().getByText('查询码已重置，旧码已失效。', { exact: true }).waitFor();
    assert.equal((await writes()).length, 2);
    assert.equal((await writes())[1].days, 365);
    await dialog().getByRole('button', { name: '复制查询码', exact: true }).click();
    await dialog().getByRole('button', { name: '完成', exact: true }).click();
    await openReset();
    assert.ok(
      await dialog().locator('.el-select__selected-item').filter({ hasText: '1年' }).count()
    );
    // A refresh failure after a successful write never re-enables reset on the success view.
    await choose('3个月（90天）');
    await control({ failRead: true, delayMs: 0 });
    await dialog().getByRole('button', { name: '确认重置', exact: true }).click();
    await dialog().getByText('查询码已重置，旧码已失效。', { exact: true }).waitFor();
    await dialog()
      .getByRole('alert')
      .filter({ hasText: /已完成.*列表/ })
      .waitFor();
    assert.equal(await dialog().getByRole('button', { name: '确认重置', exact: true }).count(), 0);
    assert.equal((await writes()).length, 3);
    if (system === 'vendure') {
      await control({ failRead: false });
      await dialog().getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('tab', { name: '主邮箱管理', exact: true }).click();
      await openReset();
      await choose('3个月（90天）');
      await dialog().getByRole('button', { name: '确认重置', exact: true }).click();
      await dialog().getByText('查询码已重置，旧码已失效。', { exact: true }).waitFor();
      assert.equal((await writes()).length, 4);
      assert.equal((await writes())[3].kind, 'primary');
      assert.equal((await writes())[3].days, 90);
    } else {
      assert.equal(
        await page.getByRole('dialog', { name: '邮箱查询与管理', exact: true }).count(),
        1
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    results.push({
      system,
      scenario:
        'cancel-draft-record-isolation-failure-retry-singleflight-copy-remember-refresh-failure',
      passed: true
    });
    await context.close();
  }
  await writeFile(
    join(evidence, 'browser-result.json'),
    JSON.stringify(
      { passed: true, fixtureOnly: true, serverStarted: false, databaseUsed: false, results },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: true, layoutCases: 24, flowCases: 2, evidence }));
} catch (error) {
  console.error(
    JSON.stringify({ fixtureErrors: activeErrors, unexpectedRequests: activeUnexpectedRequests })
  );
  await activePage
    ?.screenshot({ path: join(evidence, `browser-failure-${Date.now()}.png`) })
    .catch(() => {});
  await writeFile(
    join(evidence, `browser-failure-${Date.now()}.txt`),
    String(error.stack ?? error)
  );
  throw error;
} finally {
  await browser.close();
}
