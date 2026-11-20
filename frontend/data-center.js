/* 数据中心：查看各站访问情况与业务报表同步状态。 */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const data = window.IDLocalData;
  const dateFilter = window.IDDateFilter;
  const sheets = A.modules.sheetsStatus;
  const trafficRoute = 'data';
  const sheetsRoute = 'data/sheets';
  const scope = 'tools/website-analytics';
  const draftKey = 'data-center:traffic';
  const sites = new Map([
    ['flashcast.com.my', 'FLASH CAST 装修站'],
    ['damatong.net', '大马通'],
    ['moyaoai.com', '模钥商城'],
    ['shop.flashcast.com.my', '闪铸商城']
  ]);
  const renovation = sites.keys().next().value;
  const number = new Intl.NumberFormat('zh-CN');
  const canRead = () => data?.authRequired && ['admin', 'super'].includes(A.state.actor?.role);
  const sourceZone = site => site === renovation ? 'Asia/Kuala_Lumpur' : 'UTC';
  const filters = () => A.state.drafts.get(draftKey) ?? { site: renovation, preset: 'week' };
  const selectedDates = ({ site, preset, from, to }) => preset === 'custom'
    ? { from, to } : dateFilter.range(preset, Date.now(), sourceZone(site));
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? number.format(value) : '—';
  const columns = (site) => site === renovation
    ? [['pageViews', '浏览量', '次'], ['sessions', '访问次数', '次'], ['visitors', '访客数', '位']]
    : [['pageViews', '浏览量', '次'], ['visits', '访问次数', '次']];

  function renderTraffic() {
    const selection = filters(), { site, preset } = selection;
    const live = canRead();
    const disabled = live ? '' : 'disabled';
    return `<div class="data-traffic" data-traffic>
      <section class="panel" aria-labelledby="traffic-overview-title">
        <div class="panel-heading data-traffic-heading">
          <div class="section-title-row"><h2 id="traffic-overview-title">访问概况</h2>${A.titleInfo('访问概况',
            '一次访问可以浏览多页。装修站的访客数在所选时段内去重，不能把每日人数相加。各网站的访问次数按各自报表口径统计。' +
            '商城数据含估算，切换日期范围时，同一天的数字也可能变化。',
            'traffic-overview-help')}</div>
          <div class="data-traffic-filters">
            <div class="data-traffic-site"><label for="data-center-site">网站</label><select id="data-center-site" ${disabled}>${[...sites].map(([value, label]) =>
              `<option value="${value}"${site === value ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="data-traffic-period">${dateFilter.render({
              id: 'data-traffic-range', value: preset, ...selectedDates(selection), label: '统计时间范围',
              timeZone: sourceZone(site), max: dateFilter.range('today', Date.now(), sourceZone(site)).to,
              maxDays: 30, disabled: !live,
              onSelect(next) {
                A.state.drafts.set(draftKey, { site, ...next });
                A.render();
              }
            })}</div>
            ${A.button('刷新统计', 'data-traffic-refresh', '', '', disabled)}
          </div>
        </div>
        <div class="panel-body design-async-region" data-traffic-read>
          <div data-traffic-progress role="status" hidden></div>
          <p class="inline-notice warning data-traffic-notice" data-traffic-notice role="status" hidden></p>
          <div data-traffic-summary><p class="data-traffic-message" role="status">${live
            ? '正在读取网站统计…' : '登录业务站后可查看实际访问统计。'}</p></div>
        </div>
      </section>
      <div data-traffic-detail hidden></div>
    </div>`;
  }

  A.modules.siteDataNavigation = () => {
    const items = [[trafficRoute, '网站统计'], [sheetsRoute, '谷歌表格同步'],
      ['data/health', '数据健康'], ['data/backups', '备份与恢复'], ['data/export', '导出与保留']];
    return '<div class="panel"><nav class="tabs data-center-tabs" aria-label="数据中心栏目">' +
      items.map(([route, label]) => '<a class="tab" href="#/' + route + '"' + (A.state.route === route ? ' aria-current="page"' : '') +
        '>' + label + '</a>').join('') + '</nav></div>';
  };
  function render() {
    return A.header('数据中心', '查看各个网站的访问统计，以及业务报表同步到 Google 表格的状态。') +
      `<div class="data-center-workspace">
        ${A.modules.siteDataNavigation()}
        ${A.state.route === sheetsRoute ? sheets.render() : renderTraffic()}
      </div>`;
  }

  function reportMeta(report) {
    const timeZone = report.timeZone;
    const time = new Date(report.fetchedAt);
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short' });
    const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(time);
    const zoneNames = { UTC: '世界标准时间（UTC）', 'Asia/Kuala_Lumpur': '马来西亚时间', 'Asia/Shanghai': '北京时间' };
    const zone = zoneNames[timeZone] || new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'long' })
      .formatToParts(time).find((part) => part.type === 'timeZoneName')?.value;
    const last = report.daily.at(-1).date;
    const note = last === date.format(Date.now()) ? '今日数据仍在更新' : '末日数据截至上次读取';
    return `<div class="data-traffic-meta">
      <strong>${A.esc(report.daily[0].date)} 至 ${A.esc(last)}</strong>
      <span>统计时区 ${A.esc(zone)}</span>
      <span>上次读取 <time datetime="${time.toISOString()}">${A.esc(timestamp)}</time></span>
      ${report.provider === 'cloudflare' && report.status === 'ready' ? '<span>含估算</span>' : ''}
      <span class="data-traffic-today">${note}</span>
      ${report.thresholded ? '<span>部分数据因隐私限制未显示</span>' : ''}
    </div>`;
  }

  function renderTrend(report, metrics, open) {
    const title = '每日浏览量趋势';
    const chart = window.IDCharts.bars({
      title, unit: '次', details: false,
      rows: report.daily.map(({ date, metrics }) => ({ label: date, shortLabel: date.slice(5), pageViews: metrics?.pageViews })),
      series: [{ key: 'pageViews', label: '浏览量', tone: 'blue' }]
    });
    const rows = report.daily.map(({ date, metrics: values }) => `<tr>
      <th scope="row"><time datetime="${A.esc(date)}">${A.esc(date)}</time></th>
      ${metrics.map(([key]) => `<td>${count(values?.[key])}</td>`).join('')}
    </tr>`).join('');
    return `<section class="panel data-traffic-trend" aria-labelledby="traffic-trend-title">
      <div class="panel-heading"><div class="section-title-row"><h2 id="traffic-trend-title">${title}</h2>${A.titleInfo(title,
        '查看每天的浏览量。未收到数据的日期不画柱子，明细用「—」表示。', 'traffic-trend-help')}</div></div>
      <div class="panel-body">
        ${chart}
        <details class="data-traffic-daily"${open ? ' open' : ''}>
          <summary>每日明细${A.icon('chevron')}</summary>
          <div class="table-viewport" tabindex="0" role="region" aria-label="每日访问明细">
            <table><thead><tr><th scope="col">日期</th>${metrics.map(([, label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead>
              <tbody>${rows}</tbody></table>
          </div>
        </details>
      </div>
    </section>`;
  }

  function showTraffic(workspace, report, site, keepOpen = false) {
    const overview = workspace.querySelector('[data-traffic-summary]');
    const detail = workspace.querySelector('[data-traffic-detail]');
    if (!report || report.status === 'unconfigured') {
      overview.innerHTML = report ? '<p class="data-traffic-message" role="status">该网站尚未接入统计。</p>' : '';
      detail.replaceChildren();
      detail.hidden = true;
      return;
    }
    const meta = reportMeta(report);
    if (report.status === 'empty') {
      overview.innerHTML = meta + '<p class="data-traffic-message" role="status">该时段暂无访问数据。</p>';
      detail.replaceChildren();
      detail.hidden = true;
      return;
    }
    const metrics = columns(site);
    overview.innerHTML = meta + A.summary(metrics.map(([key, label, unit]) =>
      [label, count(report.summary[key]), unit, key === 'pageViews']));
    detail.innerHTML = renderTrend(report, metrics, keepOpen && Boolean(detail.querySelector('details[open]')));
    detail.hidden = false;
  }

  async function readTrafficReport(site, dates) {
    const { from, to } = dates;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    const report = await data.websiteAnalytics(dates, site);
    if (report?.site !== site || report.days !== days ||
        !['ready', 'empty', 'unconfigured'].includes(report.status)) throw new Error('Invalid website report');
    if (report.status !== 'unconfigured') {
      if (!report.timeZone || !Number.isFinite(Date.parse(report.fetchedAt)) ||
          !Array.isArray(report.daily) || report.daily.length !== days ||
          report.daily[0].date !== from || report.daily.at(-1).date !== to ||
          report.daily.some(row => typeof row?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) ||
          (report.status === 'ready' && !report.summary)) throw new Error('Incomplete website report');
      // Validate the reporting timezone before this snapshot can be cached.
      new Intl.DateTimeFormat('sv-SE', { timeZone: report.timeZone });
    }
    return report;
  }

  async function loadTraffic(workspace, selection, { refresh = false } = {}) {
    if (!workspace || !canRead()) return;
    const { site } = selection, dates = selectedDates(selection), query = { site, ...dates };
    const notice = workspace.querySelector('[data-traffic-notice]');
    const region = workspace.querySelector('[data-traffic-read]');
    const status = workspace.querySelector('[data-traffic-progress]');
    const key = JSON.stringify(query);
    const previous = data.queries.peek(scope, query)?.data;
    const sameSelection = workspace.dataset.trafficKey === key;
    if (!sameSelection) {
      workspace.dataset.trafficKey = key;
      showTraffic(workspace, previous, site);
    }
    notice.hidden = true;
    if (!previous) workspace.querySelector('[data-traffic-summary]').innerHTML =
      '<p class="data-traffic-message" role="status">正在读取网站统计…</p>';
    const read = A.beginRegionRead(region, status, {
      refreshButton: workspace.querySelector('[data-action="data-traffic-refresh"]')
    });
    try {
      const report = await data.queries.read(scope, query, () => readTrafficReport(site, dates), { refresh });
      if (read.current() && canRead()) showTraffic(workspace, report, site, sameSelection);
    } catch (error) {
      if (!read.current() || error.name === 'AbortError') return;
      const denied = error.status === 401 || error.status === 403;
      const hasPrevious = !denied && previous && previous.status !== 'unconfigured';
      if (!hasPrevious) showTraffic(workspace, null, site);
      notice.textContent = denied ? '当前账号无权查看网站统计。' : hasPrevious
        ? '暂时无法更新，已保留上次读取的统计。' : '暂时读不到访问数据，请刷新统计。';
      notice.hidden = false;
    } finally {
      read.finish();
    }
  }

  window.IDDesignModules.push({
    id: 'data-center',
    matches: (route) => route === trafficRoute || route === sheetsRoute,
    render,
    afterRender() {
      if (A.state.route === sheetsRoute) void sheets.refresh(document.querySelector('[data-sheets-workspace]'));
      else void loadTraffic(document.querySelector('[data-traffic]'), filters());
    },
    deactivate(region) {
      const read = region.querySelector('[data-traffic-read]');
      if (read) A.finishRegionRead(read);
    },
    onChange(node) {
      if (node.id !== 'data-center-site' || !sites.has(node.value)) return false;
      const site = node.value;
      const next = { ...filters(), site };
      if (next.preset === 'custom' && next.to > dateFilter.range('today', Date.now(), sourceZone(site)).to)
        next.preset = 'today';
      A.state.drafts.set(draftKey, next);
      A.render();
      document.getElementById('data-center-site')?.focus({ preventScroll: true });
      return true;
    },
    onClick(action, node) {
      if (action === 'sheets-refresh') {
        void sheets.refresh(node.closest('[data-sheets-workspace]'));
        return true;
      }
      if (action === 'data-traffic-refresh') {
        void loadTraffic(node.closest('[data-traffic]'), filters(), { refresh: true });
        return true;
      }
      return false;
    }
  });
})();
