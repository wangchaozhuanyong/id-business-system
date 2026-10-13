#!/usr/bin/env node
/* global document, getComputedStyle, innerWidth */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(root, process.argv[2] ?? '.runtime/workspace-dock-20261013');
assert.ok(output.startsWith(root + path.sep), '验收证据必须归入当前项目');
mkdirSync(output, { recursive: true });
const base = 'http://127.0.0.1:5413';
const tabs = ['个人工具', '在线工具', '话术文案'];
const phase = process.env.V2_WORKSPACE_DOCK_PHASE || 'all';
assert.ok(['all', 'mobile-layer', 'pagination'].includes(phase), '未知验收阶段');
const resultFile = phase === 'pagination' ? 'pagination-checks.json' : 'checks.json';
const checks =
  phase === 'mobile-layer'
    ? JSON.parse(readFileSync(path.join(output, 'checks.json'), 'utf8')).checks.filter(
        (check) =>
          ![
            '深色主题长文全文抽屉可查看',
            '窄屏右栏叠加更多菜单与编辑抽屉不溢出',
            '右栏内容独立滚动且顶部导航固定'
          ].includes(check.label)
      )
    : [];
const errors = [];
const blockedRequests = [];
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5413',
    '--strictPort'
  ],
  {
    cwd: path.join(root, 'apps/admin'),
    env: { ...process.env, VITE_API_BASE_URL: '/api', VITE_V2_REALTIME_CHANGES_ENABLED: 'false' },
    stdio: 'ignore'
  }
);
let browser;

async function settle(page) {
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function openFixture(page, query = '') {
  await page.goto(`${base}/workspace-design-fixture.html?${query}`);
  await page.locator('.v2-workspace-dock').waitFor();
  await settle(page);
}

async function expand(page) {
  const control = page.getByRole('button', { name: '展开工作区', exact: true });
  if (await control.isVisible()) await control.click();
  await page.getByRole('tab', { name: '个人工具', exact: true }).waitFor();
  await settle(page);
  await page.waitForFunction(() => {
    const box = document.querySelector('.v2-workspace-dock-drawer')?.getBoundingClientRect();
    return !box || box.width === 0 || Math.abs(box.right - innerWidth) <= 1;
  });
}

async function sortBy(page, title) {
  await page
    .locator('.v2-quick-actions-panel__toolbar')
    .getByRole('button', { name: '排序', exact: true })
    .click();
  await page.getByRole('menuitem', { name: title, exact: true }).click();
  await settle(page);
}

async function editFirst(page) {
  await page
    .locator('.v2-quick-actions-panel__item')
    .first()
    .getByRole('button', { name: /^更多：/ })
    .click();
  await page.getByRole('menuitem', { name: '编辑文案', exact: true }).click();
  const editor = page.getByRole('region', { name: '话术文案表单', exact: true });
  await editor.waitFor();
  return editor;
}

async function verifyLargePagination(page) {
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await openFixture(page, `count=100&theme=${theme}`);
      await expand(page);
      await page.getByRole('tab', { name: '话术文案', exact: true }).click();
      await sortBy(page, '标题排序');
      const pagination = page.locator('.v2-quick-actions-panel .el-pagination');
      const rows = page.locator('.v2-quick-actions-panel__item');
      let firstDock;
      let previousFirstTitle;
      for (const targetPage of [1, 7, 13]) {
        if (targetPage === 7) {
          for (let step = 0; step < 6; step++) await pagination.locator('.btn-next').click();
        } else if (targetPage === 13) {
          await pagination.locator('.el-pager').getByText('13', { exact: true }).click();
        }
        await settle(page);
        assert.equal(
          await pagination.locator('.el-pager .is-active').innerText(),
          String(targetPage)
        );
        assert.equal(await rows.count(), targetPage === 13 ? 4 : 8);
        const firstTitle = await rows.first().locator('.v2-quick-actions-panel__title').innerText();
        if (previousFirstTitle)
          assert.notEqual(firstTitle, previousFirstTitle, '分页点击未更新话术内容');
        previousFirstTitle = firstTitle;
        const label = `多文案-${theme}-${width}-第${targetPage}页`;
        const layout = await geometry(page, label);
        if (!firstDock) firstDock = layout.dock;
        else assert.deepEqual(layout.dock, firstDock, `${label}: 分页改变右栏外框`);
        const pager = await pagination.evaluate((element) => {
          const bounds = (node) => {
            const box = node.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              height: box.height
            };
          };
          return {
            frame: bounds(element),
            controls: [...element.querySelectorAll('button, .el-pager > li')].map((control) => ({
              text: control.textContent.trim(),
              ...bounds(control)
            }))
          };
        });
        for (const control of pager.controls) {
          assert.ok(
            control.x >= pager.frame.x - 1 &&
              control.right <= pager.frame.right + 1 &&
              control.right <= width + 1,
            `${label}: 分页按钮超出外框`
          );
          assert.ok(
            control.y >= pager.frame.y - 1 && control.bottom <= pager.frame.bottom + 1,
            `${label}: 分页按钮纵向裁切`
          );
          if (width <= 900)
            assert.ok(
              control.width >= 44 && control.height >= 44,
              `${label}: 手机分页点击目标未达到44px`
            );
        }
        for (let i = 0; i < pager.controls.length; i++)
          for (let j = i + 1; j < pager.controls.length; j++) {
            const left = pager.controls[i],
              right = pager.controls[j];
            assert.ok(
              Math.min(left.right, right.right) - Math.max(left.x, right.x) <= 1 ||
                Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y) <= 1,
              `${label}: 分页按钮重叠`
            );
          }
        checks.push({ label: `${label}-分页操作可见可点击`, ...pager });
        await page.screenshot({
          path: path.join(output, `pagination-${theme}-${width}-${targetPage}.png`),
          fullPage: true
        });
      }
      assert.equal(await pagination.locator('.btn-next').isDisabled(), true, '末页下一页未禁用');
      await pagination.locator('.btn-prev').click();
      assert.equal(
        await pagination.locator('.el-pager .is-active').innerText(),
        '12',
        '末页无法返回上一页'
      );
    }
  }
}

async function geometry(page, label) {
  const result = await page.evaluate(() => {
    const bounds = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      };
    };
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const textBounds = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = range.getBoundingClientRect();
      return {
        y: box.y,
        bottom: box.bottom,
        height: box.height,
        center: box.y + box.height / 2,
        width: box.width,
        lineHeight: getComputedStyle(element).lineHeight
      };
    };
    const buttons = [...document.querySelectorAll('[role="tabpanel"] button')]
      .filter(visible)
      .map((element) => ({
        label: element.textContent.trim(),
        frame: bounds(element),
        text: textBounds(element),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        ellipsis: getComputedStyle(element).textOverflow === 'ellipsis'
      }));
    const rows = [...document.querySelectorAll('.v2-quick-actions-panel__item')]
      .filter(visible)
      .map((element) => ({
        frame: bounds(element),
        children: element.children.length,
        title: textBounds(element.querySelector('.v2-quick-actions-panel__title')),
        copy: textBounds(element.querySelector('.app-button span')),
        subtitles: element.querySelectorAll('p,small').length
      }));
    const tabNodes = [...document.querySelectorAll('[role="tab"]')].filter(visible);
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dock: bounds(document.querySelector('.v2-workspace-dock')),
      main: bounds(document.querySelector('.v2-workspace')),
      tabs: tabNodes.map((element) => ({ frame: bounds(element), text: textBounds(element) })),
      buttons,
      rows
    };
  });
  assert.ok(result.scrollWidth <= result.viewport + 1, `${label}: 页面横向溢出`);
  assert.ok(Math.abs(result.dock.right - result.viewport) <= 1, `${label}: 右栏未贴住右侧`);
  if (result.viewport > 900) {
    assert.ok(result.main.right <= result.dock.x + 1, `${label}: 主内容被右栏覆盖`);
    assert.ok(result.dock.height > 800, `${label}: 右栏高度未固定`);
  }
  assert.equal(result.tabs.length, 3, `${label}: 顶部导航缺失`);
  assert.ok(
    Math.max(...result.tabs.map((tab) => tab.frame.y)) -
      Math.min(...result.tabs.map((tab) => tab.frame.y)) <=
      1,
    `${label}: 顶部导航未保持单行`
  );
  for (const button of result.buttons) {
    assert.ok(
      button.frame.x >= -1 && button.frame.right <= result.viewport + 1,
      `${label}: ${button.label} 超出视口`
    );
    assert.ok(
      button.text.height <= button.frame.height + 1,
      `${label}: ${button.label} 文字竖向裁切`
    );
    if (!button.ellipsis)
      assert.ok(
        button.scrollWidth <= button.clientWidth + 1,
        `${label}: ${button.label} 按钮横向裁切`
      );
  }
  for (const row of result.rows) {
    assert.equal(row.children, 3, `${label}: 话术行不是标题/复制/更多三个区域`);
    assert.equal(row.subtitles, 0, `${label}: 话术仍存在副标题`);
    assert.ok(Math.abs(row.title.center - row.copy.center) <= 1, `${label}: 标题与操作文字未对齐`);
  }
  checks.push({ label, ...result });
  return result;
}

try {
  const deadline = Date.now() + 30_000;
  while (!(await fetch(base).catch(() => null))?.ok) {
    assert.ok(server.exitCode === null && Date.now() < deadline, '本地验收服务器启动失败');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      blockedRequests.push({ method: request.method(), path: url.pathname, kind: 'external' });
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      blockedRequests.push({ method: request.method(), path: url.pathname, kind: 'api' });
      return route.fulfill({ status: 503, json: { message: '合成验收禁止访问真实 API' } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (phase === 'all') {
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 1024, 901, 900, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await openFixture(page, `theme=${theme}`);
        await expand(page);
        for (const [index, title] of tabs.entries()) {
          await page.getByRole('tab', { name: title, exact: true }).click();
          await settle(page);
          await geometry(page, `${theme}-${width}-${title}`);
          if (theme === 'light' && [1440, 390].includes(width))
            await page.screenshot({
              path: path.join(output, `${theme}-${width}-${index + 1}.png`),
              fullPage: true
            });
        }
        await page.getByRole('button', { name: '收起工作区', exact: true }).click();
        await settle(page);
        const collapsed = await page.locator('.v2-workspace-dock').boundingBox();
        assert.ok(collapsed.width <= 64, `${theme}-${width}: 收起后未恢复窄栏`);
        await expand(page);
        assert.equal(
          await page
            .getByRole('tab', { name: '话术文案', exact: true })
            .getAttribute('aria-selected'),
          'true',
          '收起展开丢失当前页签'
        );
      }
    }

    // Interaction checks below use only the fixture's in-memory data adapters.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openFixture(page);
    await expand(page);
    await page.getByRole('tab', { name: '在线工具', exact: true }).click();
    await page.getByRole('button', { name: '抖音解析', exact: true }).click();
    const mediaDrawer = page.locator('.v2-media-resolver-drawer');
    await mediaDrawer.waitFor();
    await mediaDrawer.locator('textarea').fill('合成验收输入，不触发解析');
    await mediaDrawer.locator('.el-drawer__close-btn').click();
    await page.getByRole('button', { name: '抖音解析', exact: true }).click();
    assert.equal(await mediaDrawer.locator('textarea').inputValue(), '合成验收输入，不触发解析');
    await mediaDrawer.locator('.el-drawer__close-btn').click();
    checks.push({ label: '在线工具抽屉关闭重开保留输入', passed: true });

    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    await page.getByRole('link', { name: 'ID 管理', exact: true }).click();
    assert.equal(await page.locator('h1').innerText(), 'ID 管理');
    assert.equal(
      await page.getByRole('tab', { name: '话术文案', exact: true }).getAttribute('aria-selected'),
      'true'
    );
    await geometry(page, '跨业务路由保持右栏和当前页签');

    const rows = page.locator('.v2-quick-actions-panel__item');
    await rows.first().getByRole('button', { name: '复制文案', exact: true }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      '第一行\n第二行，仅复制正文。'
    );
    checks.push({ label: '复制文案只复制原始正文', passed: true });
    const firstBefore = await rows.first().locator('.v2-quick-actions-panel__title').innerText();
    const secondBefore = await rows.nth(1).locator('.v2-quick-actions-panel__title').innerText();
    await rows.first().locator('[data-sort-id]').press('ArrowDown');
    await settle(page);
    assert.equal(
      await rows.first().locator('.v2-quick-actions-panel__title').innerText(),
      secondBefore
    );
    assert.equal(
      await rows.nth(1).locator('.v2-quick-actions-panel__title').innerText(),
      firstBefore
    );
    checks.push({ label: '键盘调整自定义顺序写入合成适配器并回读', passed: true });

    await sortBy(page, '最近修改');
    assert.equal(await rows.count(), 8);
    const firstPage = await geometry(page, '话术第一页');
    await page.locator('.v2-quick-actions-panel .el-pager').getByText('2', { exact: true }).click();
    assert.equal(await rows.count(), 5);
    const lastPage = await geometry(page, '话术最后一页');
    assert.deepEqual(lastPage.dock, firstPage.dock, '分页改变了右栏外框');
    const search = page.getByRole('textbox', { name: '搜索话术标题或内容', exact: true });
    await search.fill('没有匹配的合成验收文案');
    await page.getByText('没有匹配的话术文案，请调整搜索词。', { exact: true }).waitFor();
    const emptySearch = await geometry(page, '搜索无结果');
    assert.deepEqual(emptySearch.dock, firstPage.dock, '空状态改变了右栏外框');
    await page.getByRole('link', { name: '订单录入', exact: true }).click();
    assert.equal(await search.inputValue(), '没有匹配的合成验收文案');
    checks.push({ label: '跨路由保留话术搜索与排序', passed: true });

    await openFixture(page, 'save=fail-once');
    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    let editor = await editFirst(page);
    await editor.locator('input').fill('失败后仍保留的标题');
    await editor.locator('textarea').fill('合成文案草稿，失败后继续修改。');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await editor.getByText('验收模拟保存失败，请重试', { exact: true }).waitFor();
    const quickDrawer = page.locator('.v2-quick-actions-drawer');
    await quickDrawer.locator('.el-drawer__close-btn').click();
    await page.getByRole('link', { name: 'ID 管理', exact: true }).click();
    editor = await editFirst(page);
    assert.equal(await editor.locator('input').inputValue(), '失败后仍保留的标题');
    assert.equal(await editor.locator('textarea').inputValue(), '合成文案草稿，失败后继续修改。');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(
      await rows.first().locator('.v2-quick-actions-panel__title').innerText(),
      '失败后仍保留的标题'
    );
    checks.push({ label: '更多编辑/保存失败/关闭跨页恢复/成功回读', passed: true });

    await openFixture(page, 'save=slow');
    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    editor = await editFirst(page);
    await editor.locator('input').fill('提交时标题');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await editor.locator('input').fill('提交后继续编辑的标题');
    await page.waitForTimeout(850);
    assert.equal(await editor.locator('input').inputValue(), '提交后继续编辑的标题');
    checks.push({ label: '迟到保存响应不清除继续编辑的草稿', passed: true });

    await openFixture(page, 'quick-actions=empty&shortcuts=empty');
    await page.getByText('还没有个人工具', { exact: true }).waitFor();
    await geometry(page, '个人工具空状态');
    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    await page.getByText('还没有话术文案', { exact: true }).waitFor();
    await geometry(page, '话术空状态');

    await openFixture(page, 'read=fail-once');
    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    await page.getByText('话术文案加载失败', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await rows.first().waitFor();
    checks.push({ label: '首次读取失败后原位重试成功', passed: true });
  }

  if (phase !== 'pagination') {
    await openFixture(page, 'quick-actions=long&theme=dark');
    await page.getByRole('tab', { name: '话术文案', exact: true }).click();
    const longRows = page.locator('.v2-quick-actions-panel__item');
    await longRows
      .last()
      .getByRole('button', { name: /^更多：/ })
      .click();
    await page.getByRole('menuitem', { name: '查看全文', exact: true }).click();
    await page.getByRole('region', { name: '话术全文', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'dark-long-copy-drawer.png'), fullPage: true });
    checks.push({ label: '深色主题长文全文抽屉可查看', passed: true });
    const longDrawer = page.locator('.v2-quick-actions-drawer');
    await longDrawer.locator('.el-drawer__close-btn').click();
    await page.setViewportSize({ width: 390, height: 1000 });
    await settle(page);
    await expand(page);
    const headerBefore = await page
      .getByRole('tablist', { name: '工作区导航', exact: true })
      .boundingBox();
    await longRows.last().scrollIntoViewIfNeeded();
    const lastRowBox = await longRows.last().boundingBox();
    assert.ok(
      lastRowBox.y >= 0 && lastRowBox.y + lastRowBox.height <= 1001,
      '末条文案无法滚动到可见区域'
    );
    const headerAfter = await page
      .getByRole('tablist', { name: '工作区导航', exact: true })
      .boundingBox();
    assert.ok(
      Math.abs(headerAfter.y - headerBefore.y) <= 1 &&
        Math.abs(headerAfter.x - headerBefore.x) <= 1,
      '右栏滚动带动了顶部导航'
    );
    checks.push({ label: '右栏内容独立滚动且顶部导航固定', passed: true });
    await longRows
      .first()
      .getByRole('button', { name: /^更多：/ })
      .click();
    const menu = page
      .getByRole('menu')
      .filter({ has: page.getByRole('menuitem', { name: '编辑文案', exact: true }) });
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 391, '窄屏更多菜单溢出');
    await page.getByRole('menuitem', { name: '编辑文案', exact: true }).click();
    await page.getByRole('region', { name: '话术文案表单', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const box = document.querySelector('.v2-quick-actions-drawer')?.getBoundingClientRect();
      return box && box.x >= -1 && box.right <= innerWidth + 1;
    });
    const drawerBox = await longDrawer.boundingBox();
    assert.ok(drawerBox.x >= 0 && drawerBox.x + drawerBox.width <= 391, '窄屏编辑抽屉溢出');
    await page.screenshot({
      path: path.join(output, 'dark-mobile-copy-editor.png'),
      fullPage: true
    });
    checks.push({ label: '窄屏右栏叠加更多菜单与编辑抽屉不溢出', passed: true });
  }
  if (phase === 'pagination' || phase === 'all') await verifyLargePagination(page);

  assert.deepEqual(errors, [], '浏览器运行错误');
  assert.deepEqual(blockedRequests, [], '发现未由内存 fixture 覆盖的 API 或外部请求');
  writeFileSync(
    path.join(output, resultFile),
    JSON.stringify({ ok: true, checks, errors, blockedRequests }, null, 2)
  );
  console.log(`工作区浏览器验收通过：${checks.length} 项；证据 ${output}`);
} catch (error) {
  writeFileSync(
    path.join(output, resultFile),
    JSON.stringify({ ok: false, failure: String(error), checks, errors, blockedRequests }, null, 2)
  );
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
