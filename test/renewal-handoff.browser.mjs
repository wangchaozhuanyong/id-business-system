import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const source = { id: 'fixture-subscription', version: 2, number: 'OD-QA-140', customer: '测试客户',
  account: 'fixture@example.test', product: 'Claude Max', plan: 'Max 5x', payment: '银行卡',
  previousPaidCurrency: 'USD', start: '2026-11-01T10:00', expiry: '2026-11-14T10:00', reminderState: 'upcoming' };
const second = { ...source, id: 'fixture-second', number: 'OD-QA-141', account: 'second@example.test' };
const orderFixture = { ...source, orderNo: source.number, email: source.account, source: '管理员手工',
  status: '已记录', businessType: '续费', refunds: [] };

test('renewal pages keep toolbars aligned and share an accessible responsive navigation', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true,
    actor: { id: 'renewal-layout', name: '合成管理员', role: 'super' }, localFixtures: {
      commerce: { version: 1, data: { customers: [], orders: [], operating: [], tenants: [], logs: [], rentBatches: [] } },
      renewals: { version: 1, candidates: [source], items: [], canSubmitToFinance: true, reminderHours: 72 }
    } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.clock.setFixedTime(new Date('2026-11-13T06:00:00Z'));
  const routes = ['renewals', 'renewals/sent', 'renewals/ready', 'renewals/history', 'renewals/declined', 'finance-renewals'];
  await page.goto(origin + '/#/workspace/renewals/reminders');
  await page.waitForURL('**/#/workspace/renewals');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await toggleDesignTheme(page);
    for (const width of [1440, 1024, 901, 900, 521, 520, 460, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of routes) {
        const route = 'workspace/' + path;
        const region = page.locator(`#main[data-layout-route="${route}"]`);
        const toolbar = region.locator('.renewal-toolbar');
        await page.evaluate(route => { location.hash = '#/' + route; }, route);
        await toolbar.locator('input').waitFor();
        await settle(page);
        const hasTabs = path === 'finance-renewals';
        const layout = await toolbar.evaluate(node => {
          const controls = [...node.querySelectorAll('button, a, input, select, label, .footnote')]
            .filter(control => control.checkVisibility()).map(control => {
              const box = control.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
            });
          const panel = node.closest('.panel').getBoundingClientRect();
          return { controls, panel: { left: panel.left, right: panel.right } };
        });
        const label = `${route} ${width}px ${theme}`;
        for (const [i, control] of layout.controls.entries()) {
          assert(control.left >= layout.panel.left + 10 && control.right <= layout.panel.right - 10, label);
          assert(layout.controls.slice(i + 1).every(other => control.right <= other.left + 1 ||
            other.right <= control.left + 1 || control.bottom <= other.top + 1 || other.bottom <= control.top + 1), label);
        }
        if (width === 1440) {
          const centers = layout.controls.map(control => (control.top + control.bottom) / 2);
          assert(Math.max(...centers) - Math.min(...centers) <= 1, `${label} 顶部控件应在同一行`);
        }
        assert(await toolbar.getByRole('button', { name: '刷新', exact: true }).isVisible(), label);
        if (path === 'renewals') {
          assert(await toolbar.getByRole('button', { name: '提交给财务', exact: true }).isDisabled(), label);
          assert(await toolbar.getByRole('button', { name: '拒绝续费', exact: true }).isDisabled(), label);
          const order = region.locator('tr[data-row-id="' + source.id + '"]');
          const actions = order.locator('[data-column="actions"] .action-links');
          assert.deepEqual(await actions.getByRole('button').allTextContents(), ['详情', '复制订阅信息', '更多操作'], label);
          const separated = await actions.evaluate(group => {
            const [details, copy, menu] = [...group.children].map(button => button.getBoundingClientRect());
            return Math.abs(details.top - copy.top) <= 1 && Math.abs(copy.top - menu.top) <= 1 &&
              copy.left - details.right >= 8 && menu.left - copy.right >= 8 &&
              menu.right <= Math.min(innerWidth, group.closest('td').getBoundingClientRect().right) + 1;
          });
          assert(separated, label + ' 订单动作应在同一行并留出间距');
        }
        const navigation = region.locator('.renewal-progress-navigation');
        const settings = navigation.getByRole('group', { name: '续费设置', exact: true });
        assert(await navigation.getByText('办理进度', { exact: true }).isVisible(), label);
        assert(await settings.getByText('设置', { exact: true }).isVisible(), label);
        assert(await settings.getByRole('button', { name: '常用备注', exact: true }).isVisible(), label);
        assert.equal(await toolbar.getByRole('button', { name: '常用备注', exact: true }).count(), 0, label);
        if (hasTabs) {
          const statuses = navigation.getByRole('tablist', { name: '财务续费状态' });
          assert.equal(await statuses.getByRole('tab').count(), 3, label);
          assert.equal(await statuses.getByRole('tab', { selected: true }).count(), 1, label);
          if (width === 1440 && theme === 'light') {
            await statuses.getByRole('tab', { selected: true }).focus();
            for (const [key, name] of [['ArrowDown', '处理中'], ['End', '已处理'], ['Home', '待处理']]) {
              await page.keyboard.press(key);
              const selected = statuses.getByRole('tab', { name, exact: true, selected: true });
              assert(await selected.evaluate(node => node === document.activeElement), `${label} ${key} 应同时更新焦点和选中项`);
              assert(await region.getByRole('tabpanel', { name, exact: true }).isVisible(), label);
            }
          }
        } else {
          assert.equal(await navigation.locator('a[aria-current="page"]').count(), 1, label);
          assert(await settings.getByRole('button', { name: '提醒设置', exact: true }).isVisible(), label);
          assert(await settings.getByRole('button', { name: '续费提醒话术', exact: true }).isVisible(), label);
          assert.equal(await region.getByRole('link', { name: '续费提醒', exact: true }).count(), 0, label);
        }
        const groups = await navigation.locator('.renewal-navigation-items').evaluateAll(nodes => nodes.map(group => {
          const bounds = group.getBoundingClientRect();
          return { width: bounds.width, entries: [...group.children].map(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = node.getBoundingClientRect(), ink = range.getBoundingClientRect(), css = getComputedStyle(node);
            return { text: node.textContent.trim(), x: box.left, y: box.top, right: box.right,
              width: box.width, height: box.height, start: ink.left - box.left, end: box.right - ink.right,
              border: css.borderLeftColor, surface: css.backgroundColor };
          }) };
        }));
        for (const { width: groupWidth, entries } of groups) {
          const first = entries[0];
          for (const entry of entries) {
            assert(entry.start >= 7 && entry.end >= 7, `${label} ${entry.text} 应完整显示并留有内距`);
            assert.equal(entry.height, first.height, label);
            assert(!['transparent', 'rgba(0, 0, 0, 0)'].includes(entry.border) && entry.border !== entry.surface,
              `${label} ${entry.text} 静止状态应有可辨认的按钮边界`);
            if (width > 900) {
              assert.equal(entry.x, first.x, label);
              assert.equal(entry.right, first.right, label);
              assert(Math.abs(entry.start - first.start) <= 1, label);
            } else {
              assert(entry.height >= 44, `${label} 手机触控高度`);
              assert(Math.abs(entry.start - entry.end) <= 2, `${label} 手机按钮文字居中`);
            }
          }
          if (width <= 900) {
            const rows = [...new Set(entries.map(entry => entry.y))].map(y => entries.filter(entry => entry.y === y));
            if (entries.length === 5 && groupWidth <= 368) assert.deepEqual(rows.map(row => row.length), [3, 2], label);
            if (entries.length === 5 && groupWidth >= 432) assert.equal(rows.length, 1, label);
            if (entries.length <= 3) assert.equal(rows.length, 1, `${label} 当前岗位可用的三个或更少入口应同排`);
            for (const row of rows) {
              assert(row.slice(1).every((entry, index) => entry.x - row[index].right >= 7), label);
            }
          }
        }
        const rail = await navigation.boundingBox(), panel = await toolbar.boundingBox();
        if (width > 900) assert(rail.x >= panel.x + panel.width && Math.abs(rail.y - panel.y) <= 2, `${label} 右栏应与工具栏平齐`);
        else assert(rail.y + rail.height <= panel.y, `${label} 窄屏入口应在订单表上方`);
        if (path === 'renewals' || hasTabs) {
          const setting = settings.getByRole('button', { name: '常用备注', exact: true });
          await setting.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert(await setting.evaluate(node => node === document.activeElement && node.matches(':focus-visible') &&
            (getComputedStyle(node).outlineStyle !== 'none' || getComputedStyle(node).boxShadow !== 'none')), `${label} 键盘焦点应可见`);
        }
        const spacing = await spacingSnapshot(page);
        assert.equal(spacing.overflow, false, label);
        assert.deepEqual(spacing.findings, [], label);
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.unavailable, []);
  assert.deepEqual(traffic.external, []);
});

test('勾选、确认拒绝和刷新后从拒绝续费表回读，失败保留原订单', async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { actor: { id: 'staff', name: '员工', role: 'employee' }, localFixtures: {}, skipRechargeAssets: true });
  const remaining = [source, { ...source, id: 'second', number: 'OD-QA-141' }];
  const archived = Array.from({ length: 21 }, (_, i) => ({ id: 'historical-' + i,
    order: { ...source, number: 'OD-HISTORY-' + i, product: 'GPT' },
    declinedBy: '历史经办人', declinedAt: '2026-11-01T05:00:00Z' }));
  const keys = [];
  await context.route('**/api/local/renewals**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: new URL(request.url()).searchParams.get('view') === 'declined'
      ? { items: archived } : { items: [], candidates: remaining } });
    const command = request.postDataJSON();
    assert.deepEqual(command, { action: 'decline', confirmed: true, orders: [{ id: source.id, version: source.version }] });
    keys.push(request.headers()['x-id-operation']);
    if (keys.length <= 2) return route.fulfill({ status: 503, json: { error: '暂时无法确认办理结果' } });
    archived.push({ id: source.id, order: remaining.shift(), declinedBy: '员工', declinedAt: '2026-11-19T05:00:00Z' });
    return route.fulfill({ json: { saved: true, count: 1 } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.clock.setFixedTime(new Date('2026-11-13T06:00:00Z'));
  await page.goto(origin + '/#/workspace/renewals');
  const decline = page.getByRole('button', { name: '拒绝续费（1）', exact: true });
  const emptySelection = page.getByRole('button', { name: '拒绝续费', exact: true });
  await emptySelection.waitFor();
  assert(await emptySelection.isDisabled());
  await page.getByRole('checkbox', { name: '选择 ' + source.id, exact: true }).check();
  const confirm = page.getByRole('dialog', { name: '确认拒绝续费' });
  await decline.click();
  await confirm.getByText(/OD-QA-140/).waitFor();
  await confirm.getByRole('button', { name: '取消' }).click();
  assert.equal(keys.length, 0);
  await decline.click();
  await confirm.getByRole('button', { name: '确认拒绝续费' }).click();
  await page.getByText('暂时无法确认办理结果', { exact: true }).waitFor();
  await decline.click();
  await confirm.getByRole('button', { name: '确认拒绝续费' }).click();
  await page.waitForURL('**/#/workspace/renewals/declined');
  assert.equal(keys.length, 3);
  assert(keys[0] && keys.every(key => key === keys[0]));
  await page.reload();
  const table = page.getByRole('table', { name: '拒绝续费', exact: true });
  await table.getByText(source.number).waitFor();
  await table.getByText('员工', { exact: true }).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await table.locator('tbody tr').count(), 2);
  assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
  await page.getByLabel('产品', { exact: true }).selectOption(source.product);
  await table.getByText(source.number).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 1);
  const search = page.getByRole('textbox', { name: '搜索续费订单' });
  await search.fill('未匹配');
  await page.getByText('暂无符合条件的拒绝续费记录').waitFor();
  await search.fill(source.number);
  await table.getByText(source.number).waitFor();
  await page.getByRole('link', { name: '选订单', exact: true }).click();
  await page.getByText('OD-QA-141', { exact: true }).waitFor();
  assert.equal(await page.locator('tr[data-row-id="' + source.id + '"]').count(), 0);
});

test('renewal countdown uses Beijing dates, updates across expiry and keeps the current selection', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true, localFixtures: {},
    actor: { id: 'countdown-employee', name: '合成员工', role: 'employee' } });
  const candidates = [
    ['future', '2026-11-17T15:30', '剩余 3 天 5 小时'],
    ['expired', '2026-11-12 08:30', '已到期 2 天 1 小时', 'expired'],
    ['soon', '2026-11-14T10:01', '剩余不足 1 小时'],
    ['just-expired', '2026-11-14T10:00', '已到期不足 1 小时', 'expired'],
    ['utc', '2026-11-17T07:30:00Z', '剩余 3 天 5 小时'],
    ['offset', '2026-11-17T07:30:00+0000', '剩余 3 天 5 小时']
  ].map(([id, expiry, expected, reminderState = 'upcoming']) => ({ ...source, id, number: 'OD-QA-' + id, expiry, expected, reminderState }));
  const boundary = Date.parse('2026-11-14T03:00:00Z');
  const newlyDue = { ...source, id: 'newly-due', number: 'OD-QA-newly-due', expiry: '2026-11-18T11:00' };
  let reads = 0;
  await context.route('**/api/local/renewals**', route => {
    assert.equal(route.request().method(), 'GET');
    reads++;
    return route.fulfill({ json: { version: 1, candidates: reads > 1 ? [...candidates, newlyDue] : candidates,
      items: [], canSubmitToFinance: true, reminderHours: 96, nextReminderAt: reads === 1 ? boundary : null } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-14T02:00:00Z') });
  await page.goto(origin + '/#/workspace/renewals');
  const counter = id => page.locator(`tr[data-row-id="${id}"] [data-column="days"]`);
  const header = page.getByRole('columnheader', { name: '到期倒计时', exact: true });
  await header.waitFor();
  assert.equal(await header.evaluate(node => node.previousElementSibling.textContent), '原到期时间');
  for (const row of candidates.filter(row => row.reminderState === 'upcoming'))
    await counter(row.id).getByText(row.expected, { exact: true }).waitFor();
  assert.equal(await counter('expired').count(), 0);
  assert.equal(await counter('newly-due').count(), 0);
  const selection = page.getByRole('checkbox', { name: '选择 future', exact: true });
  await selection.check();
  const initialReads = reads;
  await page.clock.fastForward(61_000);
  await counter('soon').waitFor({ state: 'detached' });
  assert(await selection.isChecked(), '到期阶段更新保留其他已勾选订单');
  await page.getByRole('button', { name: '提交给财务（1）', exact: true }).waitFor();
  await page.getByLabel('订单状态', { exact: true }).selectOption('expired');
  await counter('soon').getByText('已到期不足 1 小时', { exact: true }).waitFor();
  await counter('expired').getByText('已到期 2 天 1 小时', { exact: true }).waitFor();
  await page.getByLabel('订单状态', { exact: true }).selectOption('upcoming');
  await selection.check();
  const originalCheckbox = await selection.elementHandle();
  await page.clock.fastForward(30 * 60_000);
  await counter('future').getByText('剩余 3 天 4 小时', { exact: true }).waitFor();
  assert.equal(reads, initialReads, '倒计时更新不请求业务列表');
  assert(await originalCheckbox.evaluate(node => node.isConnected && node.checked), '更新文字保留已勾选的订单');
  await page.getByRole('button', { name: '提交给财务（1）', exact: true }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await counter('future').isVisible(), '手机默认显示到期倒计时');
    const bounds = await counter('future').evaluate(cell => {
      const text = cell.querySelector('[data-renewal-countdown]').getBoundingClientRect();
      const card = cell.closest('tr').getBoundingClientRect();
      return text.left >= card.left && text.right <= card.right;
    });
    assert(bounds, '倒计时留在手机卡片内');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  const beforeHidden = await counter('future').innerText();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(3_600_000);
  assert.equal(await counter('future').innerText(), beforeHidden, '后台暂停倒计时');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await counter('future').getByText('剩余 3 天 3 小时', { exact: true }).waitFor();
  await counter('newly-due').waitFor();
  assert.equal(reads, initialReads + 1, '进入提醒范围时只读一次');
  const detachedCounter = await counter('future').elementHandle();
  const lastText = await counter('future').innerText();
  await page.getByRole('link', { name: '已送财务', exact: true }).click();
  await page.locator('#main[data-layout-route="workspace/renewals/sent"]').waitFor();
  await page.clock.fastForward(3_600_000);
  assert.equal(await detachedCounter.evaluate(node => node.textContent), lastText, '离页后停止旧倒计时');
  assert.equal(reads, initialReads + 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.unavailable, []);
  assert.deepEqual(traffic.external, []);
});

test('finance source review preserves the reason after stale versions without another checkbox', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const errors = [], posts = [];
    const requests = await interceptDesign(context, { skipRechargeAssets: true, localAuthUi: true,
      actor: { id: 'finance-fixture', name: '测试财务', role: 'finance' }, localFixtures: {} });
    let sourceVersion = 2, reviewed = false;
    await context.route('**/api/local/auth/security**', route => route.fulfill({ json: {
      available: true, bound: true, passwordConfirmed: true, devices: []
    } }));
    await context.route('**/api/local/renewals**', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { version: 3, candidates: [], items: [{
        id: 'changed-paid', version: 3, status: 'paid', order: source,
        sourceChanged: !reviewed, amount: '21.25', currency: 'USD',
        ...(!reviewed && { sourceReview: { version: sourceVersion, expiry: '2026-11-15T10:00', originalLast4: '4242' } })
      }] } });
      const command = route.request().postDataJSON(); posts.push(command);
      assert.equal(command.action, 'review-source');
      assert.equal(command.confirmed, undefined);
      if (posts.length === 1) {
        sourceVersion = 3;
        return route.fulfill({ status: 409, json: { error: '原单再次变化，请刷新后核对' } });
      }
      assert.equal(command.sourceVersion, sourceVersion);
      assert.equal(command.reason, '已核对到期时间更正');
      reviewed = true;
      return route.fulfill({ json: { saved: true } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/workspace/finance-renewals');
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole('tab', { name: '已处理', exact: true }).click();
    await page.getByRole('button', { name: '核对原单', exact: true }).click();
    const form = page.locator('#renewal-review-source-form');
    const submit = page.getByRole('button', { name: '确认并交回员工' });
    await form.getByLabel('原单更正原因').fill('已核对到期时间更正');
    assert.equal(await form.getByRole('checkbox').count(), 0);
    await submit.click();
    await form.getByText('原单再次变化，请刷新后核对', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '核对原单', exact: true }).click();
    assert.equal(await form.getAttribute('data-source-version'), '3');
    assert.equal(await form.getByLabel('原单更正原因').inputValue(), '已核对到期时间更正');
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual((await separatorSnapshot(page)).findings, []);
    await submit.click();
    await page.getByText('原单已核对，员工可以补资料提交订单', { exact: true }).waitFor();
    assert.equal(posts.length, 2);
    assert.deepEqual(errors, []); assert.deepEqual(requests.external, []);
    await context.close();
  }
});

test('renewal handoff supports personal templates, safe account clipboard use and withdrawal', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const account = '{"accountId":"account-example","email":"account@example.test"}';
  const employeePhrase = '请续费并升级到约定套餐';
  const financePhrase = '已经补足银行卡金额';
  const editedFinancePhrase = financePhrase + '，请核对新到期时间';
  const posts = [];
  const items = [];

  async function open(role, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const actor = { id: 'remark-' + role, role, name: role === 'employee' ? '测试员工' : '测试财务' };
    const traffic = await interceptDesign(context, { actor, skipRechargeAssets: true, localFixtures: {} });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    let toolbox = { version: 0, data: { shortcuts: [], phrases: [] } };
    await context.route('**/api/local/toolbox', route => {
      if (route.request().method() === 'PUT') {
        const { version, data } = route.request().postDataJSON();
        assert.equal(version, toolbox.version);
        toolbox = { version: version + 1, data };
      }
      return route.fulfill({ json: toolbox });
    });
    await context.route('**/api/local/renewals**', route => {
      if (route.request().method() === 'GET') {
        const hasActive = items.some(row => row.status !== 'withdrawn');
        return route.fulfill({ json: { items: items.map(row => ({ ...row,
          canWithdraw: role === 'employee' && row.status === 'pending',
          canTake: role === 'finance' && row.status === 'pending',
          assignedToMe: role === 'finance' && row.status === 'processing' })),
          candidates: hasActive ? [] : [source], reminderHours: 72, canSubmitToFinance: true, version: posts.length } });
      }
      const command = route.request().postDataJSON();
      posts.push(command);
      if (command.action === 'submit') {
        assert.equal(command.accountReference, account);
        assert.equal(command.remark, employeePhrase);
        items.unshift({ id: 'reference-' + posts.length, order: source, version: 1, status: 'pending',
          remark: command.remark, accountReference: command.accountReference });
      } else {
        const row = items.find(item => item.id === command.id);
        assert.equal(command.version, row.version);
        row.version++;
        if (command.action === 'claim') row.status = 'processing';
        if (command.action === 'withdraw') {
          row.status = 'withdrawn';
          delete row.accountReference;
        }
        if (command.action === 'paid') {
          assert.equal(command.financeRemark, editedFinancePhrase);
          Object.assign(row, { status: 'paid', amount: command.amount, currency: command.currency, financeRemark: command.financeRemark });
          delete row.accountReference;
        }
      }
      return route.fulfill({ json: { saved: true } });
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-13T06:00:00Z'));
    page.setDefaultTimeout(6000);
    return { page, traffic };
  }

  async function setRemarks(page, phrase) {
    await page.getByRole('button', { name: '常用备注', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置常用备注', exact: true });
    const input = dialog.getByRole('textbox', { name: '备注列表', exact: true });
    assert.equal(await input.inputValue(), '');
    await input.fill(phrase);
    await dialog.getByRole('button', { name: '保存常用备注' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }

  const { page: staff, traffic: staffTraffic } = await open('employee', 390);
  await staff.goto(origin + '/#/workspace/renewals');
  await setRemarks(staff, employeePhrase);
  const newApplication = async () => {
    await staff.getByRole('checkbox', { name: '选择 ' + source.id, exact: true }).check();
    await staff.getByRole('button', { name: '提交给财务（1）', exact: true }).click();
    const dialog = staff.getByRole('dialog', { name: '提交给财务', exact: true });
    await dialog.getByRole('combobox', { name: '常用备注', exact: true }).selectOption({ label: employeePhrase });
    assert.equal(await dialog.getByRole('textbox', { name: /^提交备注/ }).inputValue(), employeePhrase);
    return dialog;
  };
  const form = await newApplication();
  await staff.evaluate(() => navigator.clipboard.writeText('{"accessToken":"synthetic-do-not-transfer"}'));
  await form.getByRole('button', { name: '一键粘贴', exact: true }).click();
  await form.getByText(/仅支持账号标识/).waitFor();
  const accountField = form.getByRole('textbox', { name: '账号 JSON / ID', exact: true });
  assert.equal(await accountField.inputValue(), '');
  await accountField.fill('{"password":"synthetic-do-not-transfer"}');
  await form.getByRole('button', { name: '确认提交给财务' }).click();
  await form.getByText(/仅支持账号标识/).waitFor();
  assert.equal(posts.length, 0);
  await staff.evaluate(value => navigator.clipboard.writeText(value), account);
  await form.getByRole('button', { name: '一键粘贴', exact: true }).click();
  await staff.waitForFunction(value => document.querySelector('#renewal-account-reference')?.value === value, account);
  await staff.evaluate(() => navigator.clipboard.writeText(''));
  await form.getByRole('button', { name: '一键复制', exact: true }).click();
  await staff.getByText('账号资料已复制', { exact: true }).waitFor();
  assert.equal(await staff.evaluate(() => navigator.clipboard.readText()), account);
  await form.getByRole('button', { name: '确认提交给财务' }).click();
  await staff.waitForURL('**/#/workspace/renewals/sent');
  await staff.locator('[data-renewal-list]').getByText(employeePhrase, { exact: true }).waitFor();
  await staff.getByRole('button', { name: '撤回', exact: true }).click();
  await staff.getByRole('button', { name: '确认撤回', exact: true }).click();
  await staff.getByText('已撤回续费申请', { exact: true }).waitFor();
  await staff.getByRole('link', { name: '办理记录' }).click();
  await staff.getByText('已撤回', { exact: true }).waitFor();
  assert.equal(await staff.getByRole('button', { name: '查看账号资料', exact: true }).count(), 0);
  await staff.getByRole('link', { name: '选订单' }).click();
  const retry = await newApplication();
  await retry.getByRole('textbox', { name: '账号 JSON / ID', exact: true }).fill(account);
  await retry.getByRole('button', { name: '确认提交给财务' }).click();
  await staff.waitForURL('**/#/workspace/renewals/sent');

  const { page: finance, traffic: financeTraffic } = await open('finance', 1440);
  await finance.goto(origin + '/#/workspace/finance-renewals');
  await setRemarks(finance, financePhrase);
  await finance.getByRole('button', { name: '查看账号资料', exact: true }).click();
  const details = finance.getByRole('dialog', { name: '账号资料', exact: true });
  await details.getByRole('button', { name: '一键复制', exact: true }).click();
  await finance.getByText('账号资料已复制', { exact: true }).waitFor();
  assert.equal(await finance.evaluate(() => navigator.clipboard.readText()), account);
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  await finance.getByRole('button', { name: '接手', exact: true }).click();
  await finance.getByRole('tab', { name: '处理中', exact: true }).click();
  await finance.getByRole('button', { name: '登记实付', exact: true }).click();
  const replyDrawer = finance.getByRole('dialog', { name: '登记续费实付', exact: true });
  const picker = replyDrawer.getByRole('combobox', { name: '常用备注', exact: true });
  assert.equal(await picker.getByRole('option', { name: employeePhrase }).count(), 0);
  await picker.selectOption({ label: financePhrase });
  const reply = replyDrawer.getByRole('textbox', { name: '财务回复', exact: true });
  assert.equal(await reply.inputValue(), financePhrase);
  await reply.fill(editedFinancePhrase);
  await replyDrawer.getByRole('textbox', { name: /^实际付款金额/ }).fill('20');
  await replyDrawer.getByRole('button', { name: '保存实付', exact: true }).click();
  await finance.getByText('已交回续费管理，等待员工补资料', { exact: true }).waitFor();
  await staff.getByRole('link', { name: '待补资料' }).click();
  await staff.getByRole('button', { name: '刷新', exact: true }).click();
  await staff.getByText(editedFinancePhrase, { exact: true }).waitFor();
  assert.deepEqual(posts.map(post => post.action), ['submit', 'withdraw', 'submit', 'claim', 'paid']);
  assert.deepEqual(staffTraffic.external, []);
  assert.deepEqual(financeTraffic.external, []);
});

test('staff confirms a batch and finance returns a verified replacement for a new order', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  let rows = [], available = [source, second];
  const actions = [], errors = [];
  const timing = [];
  const remark = '请核对本次套餐后办理续费';
  const financeRemark = '已补足银行卡金额，续费处理完成';
  const originalCard = '4242424242424242424';
  const usedCard = '4111111111111111';
  const diagnostic = 'ac6cc6fd-707d-49c4-9d1c-37eee88a7bf8';
  let rejectFinish = true;
  let financeAvailable = false;
  let failedSubmit;
  async function open(role, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const actor = { id: role + '-fixture', name: '测试' + role, email: role + '@example.test', role };
    const requests = await interceptDesign(context, { actor, localAuthUi: true, changeEvents: true, siteTelemetry: true,
      skipRechargeAssets: true, localFixtures: {
      commerce: { version: 2, data: { customers: [], orders: [orderFixture], operating: [], tenants: [], logs: [], rentBatches: [] } }
    } });
    await context.route('**/api/local/site-management/timing', route =>
      route.fulfill({ status: 204 }).then(() => timing.push(route.request().postDataJSON())));
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, options) => {
        if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const revision = (type, value) => controller.enqueue(new TextEncoder().encode(
            'event: ' + type + '\ndata: ' + JSON.stringify({ schema: 1, versions: { 'renewal-handoffs': value + ':0:0' } }) + '\n\n'));
          revision('snapshot', '0');
          window.renewalChanged = value => revision('change', value);
        } }), { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    await context.route('**/api/local/renewals**', route => {
      const request = route.request();
      if (request.method() === 'GET') {
        const params = new URL(request.url()).searchParams;
        if (params.get('view') === 'cards') {
          assert.equal(role, 'finance');
          assert.equal(params.get('id'), 'case-0');
          return route.fulfill({ json: { items: [{ id: 'recharge:1', number: usedCard, label: '代充卡' }] } });
        }
        const current = rows.map(row => ({ ...row, canTake: role === 'finance' && row.status === 'pending',
          canFinish: role === 'employee' && row.status === 'paid' && !row.sourceChanged, assignedToMe: role === 'finance',
          ...(role === 'finance' && row.id === 'case-0' && { originalCardNumber: originalCard }),
          ...(row.id === 'case-0' && row.last4 && { cardNumber: usedCard }),
          ...(role === 'finance' && row.id === 'case-1' && { order: { ...row.order, originalLast4: '1111' } }) }));
        return route.fulfill({ json: { version: actions.length, items: current, candidates: available,
          reminderHours: 72, canSubmitToFinance: financeAvailable } });
      }
      const body = request.postDataJSON();
      assert.match(request.headers()['x-id-operation'], /^[\da-f-]{36}$/);
      if (body.action === 'finish') {
        assert.equal(request.headers()['x-id-measured-action'], 'order-save');
        if (rejectFinish) {
          rejectFinish = false;
          return route.fulfill({ status: 409, headers: { 'X-ID-Diagnostic': diagnostic },
            json: { error: '合成原单发生变化，请重新核对' } });
        }
      }
      if (body.action === 'submit') {
        if (!failedSubmit) {
          failedSubmit = request.headers()['x-id-operation'];
          return route.fulfill({ status: 409, json: { error: '当前没有其他账号可以处理这笔续费，请先启用财务账号。' } });
        }
        assert.equal(request.headers()['x-id-operation'], failedSubmit);
      }
      actions.push(body.action);
      if (body.action === 'submit') {
        assert.equal(body.confirmed, undefined);
        assert.equal(body.remark, remark);
        assert.deepEqual(body.orders, [{ id: source.id, version: 2 }, { id: second.id, version: 2 }]);
        rows = available.map((order, index) => ({ id: 'case-' + index, version: 1, status: 'pending', order, remark: body.remark,
          submittedAt: '2026-11-13T05:00:00Z', submittedBy: '客服甲' }));
        available = [];
      } else {
        const row = rows.find(item => item.id === body.id);
        assert.equal(body.version, row.version);
        row.version++;
        if (body.action === 'claim') row.status = 'processing';
        if (body.action === 'paid') {
          assert.equal(body.cardMode, 'manual');
          assert.equal(body.amount, '22.25');
          assert.equal(body.cardNumber, usedCard);
          assert.equal(body.confirmed, undefined);
          assert.equal(body.financeRemark, financeRemark);
          Object.assign(row, { status: 'paid', amount: body.amount, currency: body.currency, last4: '1111',
            financeRemark: body.financeRemark });
        }
        if (body.action === 'review-source') {
          assert.deepEqual(body, { action: 'review-source', id: row.id, version: 4, sourceVersion: 3,
            reason: '原到期时间登记更正' });
          row.sourceChanged = false;
          delete row.sourceReview;
        }
        if (body.action === 'finish') {
          assert.equal(body.saleAmount, '160.00');
          assert.equal(body.expiry, '2026-12-14T10:00');
          assert.equal(body.cardNumber, undefined);
          Object.assign(row, { status: 'complete', newOrderNo: 'OD-QA-NEW', completedAt: '2026-11-13T08:00:00Z' });
          return route.fulfill({ json: { saved: true, orderNo: 'OD-QA-NEW' } });
        }
      }
      return route.fulfill({ json: { saved: true } });
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-13T06:00:00Z'));
    page.setDefaultTimeout(6500);
    page.on('pageerror', error => errors.push(error.message));
    return { page, requests };
  }
  const staff = await open('employee', 390);
  await staff.page.goto(origin + '/#/workspace/renewals');
  await staff.page.getByRole('heading', { name: '续费管理', exact: true }).waitFor();
  const navigation = staff.page.getByRole('navigation', { name: '续费办理进度' });
  const workbench = staff.page.locator('[data-renewal-handoff]');
  assert.equal(await navigation.getByRole('link', { name: '选订单' }).getAttribute('aria-current'), 'page');
  const mobile = await navigation.boundingBox();
  assert(mobile.y + mobile.height <= (await workbench.boundingBox()).y);
  await staff.page.setViewportSize({ width: 1440, height: 900 });
  const desktop = await navigation.boundingBox();
  const queue = await workbench.boundingBox();
  assert(desktop.x >= queue.x + queue.width && Math.abs(desktop.y - queue.y) <= 1);
  await navigation.getByRole('link', { name: '已送财务', exact: true }).click();
  const sentSearch = staff.page.getByRole('textbox', { name: '搜索续费订单' });
  await sentSearch.fill('旧搜索条件');
  await sentSearch.press('Enter');
  await staff.page.getByLabel('产品', { exact: true }).selectOption('Gemini');
  await navigation.getByRole('link', { name: '选订单', exact: true }).click();
  await staff.page.setViewportSize({ width: 390, height: 900 });
  await staff.page.getByRole('checkbox', { name: '选择当前页' }).check();
  const send = staff.page.getByRole('button', { name: '提交给财务（2）' });
  await staff.page.getByText('当前没有其他账号可以处理这笔续费，请先启用财务账号。', { exact: true }).waitFor();
  assert(await send.isDisabled());
  financeAvailable = true;
  await staff.page.getByRole('button', { name: '刷新', exact: true }).click();
  await send.click();
  const submitDrawer = staff.page.getByRole('dialog', { name: '提交给财务', exact: true });
  const note = submitDrawer.getByLabel(/^提交备注/);
  const submit = submitDrawer.getByRole('button', { name: '确认提交给财务' });
  await submit.click();
  assert.equal(failedSubmit, undefined, '空白备注不发送请求');
  await note.fill(remark);
  await submit.click();
  await submitDrawer.getByRole('alert').getByText('当前没有其他账号可以处理这笔续费，请先启用财务账号。').waitFor();
  await staff.page.keyboard.press('Escape');
  await send.click();
  assert.equal(await note.inputValue(), remark);
  await submit.click();
  assert.equal(await staff.page.locator('#confirm-dialog[open]').count(), 0);
  await staff.page.waitForURL('**/#/workspace/renewals/sent');
  assert.equal(await sentSearch.inputValue(), '');
  await staff.page.getByText('待财务', { exact: true }).first().waitFor();
  await staff.page.locator('tr[data-row-id="case-0"]').getByText(remark, { exact: true }).waitFor();
  await staff.page.evaluate(() => window.IDDesignAPI.go('workspace/finance-renewals'));
  await staff.page.getByRole('heading', { name: '访问受限' }).waitFor();
  const finance = await open('finance', 1440);
  await finance.page.goto(origin + '/#/workspace/finance-renewals');
  const initialFinance = finance.page.locator('tr[data-row-id="case-0"]');
  await initialFinance.getByText(remark, { exact: true }).waitFor();
  await finance.page.getByRole('columnheader', { name: '原用卡号', exact: true }).waitFor();
  await finance.page.getByRole('columnheader', { name: '本次用卡号', exact: true }).waitFor();
  await initialFinance.locator('[data-column="originalCard"]').getByText(originalCard, { exact: true }).waitFor();
  await finance.page.locator('tr[data-row-id="case-1"] [data-column="originalCard"]')
    .getByText('完整卡号待核对', { exact: true }).waitFor();
  await initialFinance.getByRole('button', { name: '接手' }).click();
  await finance.page.getByRole('tab', { name: '处理中' }).click();
  await initialFinance.getByRole('button', { name: '登记实付' }).click();
  const drawer = finance.page.locator('#drawer');
  await drawer.getByText(remark, { exact: true }).waitFor();
  await drawer.getByText(originalCard, { exact: true }).waitFor();
  await drawer.getByLabel('实际付款金额').fill('22.25');
  await drawer.getByLabel('本次使用的卡').selectOption('pool');
  assert.equal(await drawer.locator('#renewal-cardId option[value="recharge:1"]').textContent(), usedCard + ' · 代充卡');
  await drawer.getByLabel('本次使用的卡').selectOption('manual');
  await drawer.getByLabel('本次银行卡号').fill(usedCard);
  await drawer.getByRole('textbox', { name: '财务回复', exact: true }).fill(financeRemark);
  assert.equal(await drawer.locator('#renewal-confirmed').count(), 0);
  await drawer.getByRole('button', { name: '保存实付' }).click();
  const important = finance.page.getByRole('dialog', { name: '确认重要操作' });
  await finance.page.getByText('已交回续费管理，等待员工补资料').waitFor();
  assert.equal(await important.count(), 0);
  await finance.page.getByRole('tab', { name: '已处理' }).click();
  await initialFinance.locator('[data-column="last4"]').getByText(usedCard, { exact: true }).waitFor();
  await finance.page.setViewportSize({ width: 320, height: 850 });
  await finance.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await initialFinance.getByRole('button', { name: '更多资料', exact: true }).click();
  for (const number of [originalCard, usedCard]) {
    const cell = initialFinance.getByText(number, { exact: true });
    await cell.waitFor();
    assert(await cell.evaluate(node => {
      const text = document.createRange();
      text.selectNodeContents(node);
      const bounds = text.getBoundingClientRect();
      const card = node.closest('tr').getBoundingClientRect();
      return bounds.left >= card.left && bounds.right <= card.right;
    }), '手机展开后完整卡号应留在卡片内');
  }
  await settle(finance.page);
  assert.equal(await finance.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual((await separatorSnapshot(finance.page)).findings, []);
  Object.assign(rows[0], { version: 4, sourceChanged: true, sourceReview: {
    version: 3, expiry: '2026-11-15T10:00', originalLast4: '4242'
  } });
  await finance.page.evaluate(() => window.renewalChanged(4));
  await initialFinance.getByRole('button', { name: '核对原单' }).click();
  await drawer.getByText('2026-11-15 10:00', { exact: true }).waitFor();
  assert.equal(await finance.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await drawer.getByLabel('原单更正原因').fill('原到期时间登记更正');
  await drawer.getByRole('button', { name: '确认并交回员工' }).click();
  await finance.page.getByText('原单已核对，员工可以补资料提交订单').waitFor();
  await staff.page.evaluate(() => window.IDDesignAPI.go('workspace/renewals/ready'));
  await staff.page.getByText('暂无符合条件的订单', { exact: true }).waitFor();
  await staff.page.waitForFunction(() => window.IDChangeSync?.status().snapshots > 0);
  await staff.page.evaluate(() => window.renewalChanged(3));
  await staff.page.getByText(financeRemark, { exact: true }).waitFor();
  await staff.page.getByRole('link', { name: '补资料并提交' }).click();
  await staff.page.getByText(financeRemark, { exact: true }).waitFor();
  await staff.page.getByText(usedCard, { exact: true }).waitFor();
  const form = staff.page.locator('#renewal-finish-form');
  const receipt = form.getByLabel('客户实收金额');
  await receipt.fill('160.00');
  await receipt.focus();
  await staff.page.evaluate(() => window.renewalChanged(4));
  await staff.page.waitForFunction(() => window.IDLocalData.pendingChangeVersions(['renewal-handoffs'])['renewal-handoffs'] === undefined);
  assert.equal(await receipt.evaluate(input => input === document.activeElement), true);
  await staff.page.getByRole('link', { name: '返回待补资料' }).click();
  await staff.page.getByRole('link', { name: '补资料并提交' }).click();
  assert.equal(await form.getByLabel('客户实收金额').inputValue(), '160.00');
  await form.getByLabel('新到期时间（北京）').fill('2026-12-14T10:00');
  await form.getByRole('button', { name: '提交订单' }).click();
  await form.getByRole('button', { name: '复制编号' }).waitFor();
  assert.equal(await form.getByLabel('客户实收金额').inputValue(), '160.00');
  assert.equal(await form.getByRole('alert').getByText(diagnostic, { exact: true }).count(), 1);
  await form.getByRole('button', { name: '提交订单' }).click();
  await staff.page.getByText('OD-QA-NEW', { exact: true }).first().waitFor();
  assert.deepEqual(timing.filter(row => row.id === diagnostic).map(row => [row.activity, row.result]), [['order-save', 'blocked']]);
  assert.match(staff.page.url(), /#\/workspace\/renewal-submit\/case-0$/);
  await staff.page.getByRole('link', { name: '查看办理记录' }).click();
  await staff.page.waitForURL('**/#/workspace/renewals/history');
  await staff.page.getByText('已续费', { exact: true }).waitFor();
  const admin = await open('admin', 1440);
  await admin.page.goto(origin + '/#/orders/claude');
  await admin.page.getByText(source.account, { exact: true }).first().waitFor();
  assert.equal(await admin.page.getByRole('checkbox', { name: '选择当前页' }).count(), 0);
  assert.equal(await admin.page.getByRole('button', { name: '付租批次', exact: true }).count(), 0);
  assert.deepEqual(actions, ['submit', 'claim', 'paid', 'review-source', 'finish']);
  assert.deepEqual(errors, []);
  for (const { requests } of [staff, finance, admin]) assert.deepEqual(requests.external, []);
});
