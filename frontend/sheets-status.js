/* Google 表格同步进程的只读状态。 */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const data = window.IDLocalData;
  const snapshots = new WeakMap();
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium'
  });
  const states = {
    preview: ['设计预览', '', '登录业务站后可查看实际同步状态。'],
    loading: ['正在读取', '', '正在获取最新同步回执。'],
    unconfigured: ['未接入状态上报', 'warning', '此站点未接入后台回执，暂无法确认同步状态。'],
    no_receipt: ['未收到有效回执', 'warning', '暂未取得同步进程的有效上报。'],
    waiting: ['等待同步核对', 'warning', '已收到后台上报，尚未取得近期成功记录。'],
    healthy: ['同步正常', 'success', '近期已收到同步成功回执，且未报告连续失败。'],
    retrying: ['等待重试', 'warning', '最近一次同步未完成，后台会自动重试。'],
    failed: ['同步异常', 'danger', '后台报告连续失败或校验异常，请检查同步服务。'],
    stale: ['同步回执超时', 'warning', '超过 15 分钟未取得有效回执或成功校验。请核对同步服务。'],
    error: ['状态读取失败', 'danger', '请刷新状态重试。'],
    forbidden: ['访问受限', 'danger', '当前账号无权查看同步状态。']
  };
  const reportDetails = new Map([
    ['邮箱管理', ['mail', 'teal', '库存邮箱、托管邮箱池']],
    ['账号管理', ['key', 'blue', '库存账号、苹果 ID 余额']],
    ['订单管理', ['orders', 'violet', '业务订单、代充核对记录']],
    ['客户管理', ['users', 'cyan', '客户、租户']]
  ]);
  const canRead = () => data?.authRequired && ['admin', 'super'].includes(A.state.actor?.role);
  const heading = (id, label, help, action = '') =>
    `<div class="sheets-section-head"><div class="section-title-row"><h2 id="${id}">${label}</h2>${A.titleInfo(label, help, id + '-help')}</div>${action}</div>`;
  const timeValue = (at) => Number.isSafeInteger(at) && at > 0 && at <= 8.64e15
    ? `<time datetime="${new Date(at).toISOString()}">${time.format(at)}</time>` : '—';
  const metrics = (snapshot) => [
    ['最近同步完成', timeValue(snapshot?.verifiedAt)],
    ['最近状态上报', timeValue(snapshot?.reportedAt)],
    ['连续失败', Number.isSafeInteger(snapshot?.failures) && snapshot.failures >= 0
      ? `${snapshot.failures === 7 ? '7+' : snapshot.failures} 次` : '—']
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  const statusLine = (state, message) => {
    const [label, tone, detail] = states[state];
    return `<span class="tag sheets-state ${tone}" data-sheets-state="${state}">${label}</span><p>${message || detail}</p>`;
  };

  function render() {
    const live = canRead();
    return `<div class="sheets-workspace" data-sheets-workspace>
        <section class="panel" aria-labelledby="sheets-status-title">
          ${heading('sheets-status-title', '同步状态', '时间统一显示为北京时间。最近同步完成与最近状态上报分别记录；「—」表示没有可用数据。刷新仅重新读取状态。',
            live ? A.button('刷新状态', 'sheets-refresh') : '')}
          <div class="panel-body sheets-status-body">
            <div class="sheets-status-line" data-sheets-status role="status">${statusLine(live ? 'loading' : 'preview')}</div>
            <dl class="sheets-metrics" data-sheets-metrics>${metrics()}</dl>
          </div>
        </section>
        <section class="panel" aria-labelledby="sheets-scope-title">
          ${heading('sheets-scope-title', '同步范围', '业务资料由本系统单向写入 Google 表格。微软库存邮箱暂不在同步范围内；苹果 ID 列在账号管理。密码、验证码、查询码、付款凭据及完整银行卡号不会写入。', '<span class="tag" data-sheets-count hidden></span>')}
          <div class="panel-body" data-sheets-scope><p class="sheets-scope-note">${live ? '正在读取同步范围…' : '登录业务站后可查看工作表及字段。'}</p></div>
        </section>
      </div>`;
  }

  function showScope(workspace, tabs) {
    const scope = workspace.querySelector('[data-sheets-scope]');
    const count = workspace.querySelector('[data-sheets-count]');
    count.hidden = !tabs?.length;
    count.textContent = tabs?.length ? `${tabs.length} 个工作表` : '';
    scope.innerHTML = tabs?.length ? `<div class="sheets-reports">${tabs.map(({ name, columns }) => {
      const [icon, tone, source] = reportDetails.get(name) || ['orders', 'blue', '业务资料'];
      return `<article class="sheets-report">
        <div class="sheets-report-title"><span class="sheets-report-icon" data-tone="${tone}">${A.icon(icon)}</span><h3>${A.esc(name)}</h3><span class="tag">${columns.length} 列</span></div>
        <p class="sheets-report-source"><span>来源</span>${source}</p>
        <details class="sheets-report-fields">
          <summary aria-label="查看${A.esc(name)}同步字段">同步字段${A.icon('chevron')}</summary>
          <ol>${columns.map(label => `<li>${A.esc(label)}</li>`).join('')}</ol>
        </details>
      </article>`;
    }).join('')}</div>` : '<p class="sheets-scope-note">暂未取得工作表和字段信息。</p>';
  }

  async function refresh(workspace) {
    const button = workspace?.querySelector('[data-action="sheets-refresh"]');
    if (!button || button.getAttribute('aria-disabled') === 'true' || !canRead()) return;
    const status = workspace.querySelector('[data-sheets-status]');
    const values = workspace.querySelector('[data-sheets-metrics]');
    const previous = snapshots.get(workspace);
    const current = () => workspace.isConnected && canRead();
    button.setAttribute('aria-disabled', 'true');
    if (previous) status.querySelector('p').textContent = '正在刷新同步状态…';
    else status.innerHTML = statusLine('loading');
    try {
      const snapshot = await data.sheetsStatus();
      if (!current()) return;
      if (!Object.hasOwn(states, snapshot.state) || !Array.isArray(snapshot.tabs) ||
          snapshot.tabs.some(tab => typeof tab?.name !== 'string' || !Array.isArray(tab.columns)))
        throw new Error('Invalid Sheets status');
      status.innerHTML = statusLine(snapshot.state);
      values.innerHTML = metrics(snapshot);
      if (!previous || JSON.stringify(previous.tabs) !== JSON.stringify(snapshot.tabs)) showScope(workspace, snapshot.tabs);
      snapshots.set(workspace, snapshot);
    } catch (error) {
      if (!current()) return;
      const denied = error.status === 401 || error.status === 403;
      status.innerHTML = denied ? statusLine('forbidden') : statusLine('error', previous?.reportedAt
        ? '暂时无法更新状态。下方保留上次读取的数据，请刷新重试。' : '');
      if (!previous || denied) {
        snapshots.delete(workspace);
        values.innerHTML = metrics();
        showScope(workspace);
      }
    } finally {
      button.removeAttribute('aria-disabled');
    }
  }

  A.modules.sheetsStatus = { render, refresh };
})();
