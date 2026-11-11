import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test(
  'recharge table messages stay within their columns and retain full text',
  { timeout: 45_000 },
  async (t) => {
    const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
    const browser = await playwright.chromium.launch({
      channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const message = '结账阶段等待超时。' + '长文字'.repeat(100) + ' <img src=x> "末尾"';
    const tasks = Array.from({ length: 23 }, (_, index) => ({
      id: `fixture-${index}`,
      cdk: 'KC-FIXTURE',
      token: 'test@example.test',
      message,
      automation: { phase: '准备订阅' },
      progress: 20,
      status: 'failed'
    }));
    const holds = [{ id: 1, accountEmail: 'test@example.test', reason: message }];
    let taskRows = tasks;
    await interceptDesign(page.context(), { localFixtures: {} });
    await page.route('**/integrations/codexdaichong/api/admin/**', (route) => {
      const path = new URL(route.request().url()).pathname.split('/').pop();
      if (path === 'data')
        return route.fulfill({
          json: {
            stats: { total: taskRows.length, success: 0, failed: taskRows.length },
            config: {},
            logs: taskRows,
            manual_holds: []
          }
        });
      if (path === 'task-logs') return route.fulfill({ json: { tasks: taskRows } });
      if (path === 'activation-manual-holds')
        return route.fulfill({ json: { success: true, holds } });
      if (path === 'sessions')
        return route.fulfill({
          json: {
            items: [
              {
                job_key: 'fixture-session',
                token_preview: 'test@example.test',
                message,
                status: 'failed'
              }
            ],
            total: 1
          }
        });
      return route.fallback();
    });
    await page.goto(origin + '/#/online-recharge/chatgpt');
    const frame = page.frameLocator('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe[data-view-group="admin"]:not([hidden])');
    async function select(view) {
      await page.locator(`button[data-view="${view}"]`).click();
      await frame.locator(`#${view}.active`).waitFor();
    }
    async function checkRow(body) {
      const row = frame.locator(`#${body} tr`).first();
      const preview = row.locator('.recharge-cell-text').first();
      await preview.waitFor();
      assert.equal(await preview.getAttribute('title'), message);
      assert.deepEqual(
        await preview.evaluate((node) => {
          const cell = node.closest('td');
          const style = getComputedStyle(node);
          return {
            overflow: style.overflowX,
            ellipsis: style.textOverflow,
            textClipped: node.scrollWidth > node.clientWidth,
            insideCell:
              node.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 1,
            cellFits: cell.scrollWidth <= cell.clientWidth + 1
          };
        }),
        {
          overflow: 'hidden',
          ellipsis: 'ellipsis',
          textClipped: true,
          insideCell: true,
          cellFits: true
        }
      );
      assert.equal(await row.locator('td:last-child button').first().isEnabled(), true);
      assert.equal(
        await row
          .locator('td:last-child')
          .evaluate((cell) => cell.scrollWidth <= cell.clientWidth + 1),
        true
      );
      assert.equal(await row.locator('img').count(), 0);
      return preview;
    }

    await select('logs');
    await frame.getByRole('button', { name: '停止自动刷新' }).click();
    await checkRow('log_body');
    await frame.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await frame.locator('#log_body tr').count(), 3);
    await checkRow('log_body');
    await frame.getByRole('button', { name: '上一页', exact: true }).click();

    await select('sessions');
    await checkRow('session_body');
    await page.locator('#theme-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await checkRow('session_body');
    await select('logs');
    const taskPreview = await checkRow('log_body');
    await taskPreview.press('Enter');
    const dialog = frame.getByRole('dialog', { name: '完整内容' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.recharge-cell-full-text').textContent(), message);
    assert.equal(await dialog.locator('img').count(), 0);
    await dialog.getByRole('button', { name: '关闭' }).press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    await frame.getByRole('tab', { name: '待人工确认', exact: true }).click();
    const holdPreview = await checkRow('activation_manual_hold_body');
    await holdPreview.tap();
    assert.equal(await dialog.locator('.recharge-cell-full-text').textContent(), message);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await frame.getByRole('tab', { name: '任务管理', exact: true }).click();
    taskRows = [];
    await frame.getByRole('button', { name: '立即刷新' }).click();
    await frame.getByText('暂无任务记录', { exact: true }).waitFor();
    assert.equal(await frame.locator('#log_body .recharge-cell-text').count(), 0);
    assert.deepEqual(errors, []);
  }
);
