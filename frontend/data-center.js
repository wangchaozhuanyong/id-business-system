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
  const visitScope = 'tools/website-visits';
  const visitorScope = 'tools/storefront-visitors';
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
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const count = value => validCount(value) ? number.format(value) : '—';
  const columns = (site) => site === renovation
    ? [['visitors', '访客数（GA4）', '位'], ['pageViews', '浏览量', '次'], ['sessions', '访问次数', '次']]
    : [['visitors', '访客数（商城）', '位'], ['pageViews', '浏览量', '次'], ['visits', '访问次数', '次']];

  function renderTraffic() {
    const selection = filters(), { site, preset } = selection;
    const live = canRead();
    const disabled = live ? '' : 'disabled';
    const overviewHelp = site === renovation
      ? '访客数是 GA4 在所选时段去重后的用户数，用于估计到访人数。阻止统计的浏览器可能漏计。' +
        '统计使用马来西亚时间。原始 IP 采集见「监控中心 → 网站监控 → 访问记录与 IP」。'
      : '访客数按所选时段对商城已同意统计的访客去重，为估算人数。' +
        '浏览量和访问次数来自 Cloudflare，独立 IP 来自单独的采集。商城报表使用世界标准时间（UTC）。';
    return `<div class="data-traffic" data-traffic>
      <section class="panel" aria-labelledby="traffic-overview-title">
        <div class="panel-heading data-traffic-heading">
          <div class="section-title-row"><h2 id="traffic-overview-title">访问概况</h2>${A.titleInfo('访问概况', overviewHelp,
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
          <p class="inline-notice warning data-traffic-notice" data-traffic-visitor-notice role="status" hidden></p>
          <p class="inline-notice warning data-traffic-notice" data-traffic-ip-notice role="status" hidden></p>
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

  function reportMeta(report, site) {
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
      <span>${site === renovation ? 'GA4' : 'Cloudflare'} 上次读取 <time datetime="${time.toISOString()}">${A.esc(timestamp)}</time></span>
      ${report.provider === 'cloudflare' && report.status === 'ready' ? '<span>含估算</span>' : ''}
      <span class="data-traffic-today">${note}</span>
      ${report.thresholded ? '<span>部分数据因隐私限制未显示</span>' : ''}
    </div>`;
  }

  function renderTrend(daily, metrics, [key, label, unit], open) {
    const title = key === 'visitors' ? '每日访客趋势' : '每日浏览量趋势';
    const chart = window.IDCharts.bars({
      title, unit, details: false,
      rows: daily.map(({ date, metrics }) => ({ label: date, shortLabel: date.slice(5), [key]: metrics?.[key] })),
      series: [{ key, label, tone: 'blue' }]
    });
    const rows = daily.map(({ date, metrics: values }) => `<tr>
      <th scope="row"><time datetime="${A.esc(date)}">${A.esc(date)}</time></th>
      ${metrics.map(([key]) => `<td>${count(values?.[key])}</td>`).join('')}
    </tr>`).join('');
    return `<section class="panel data-traffic-trend" aria-labelledby="traffic-trend-title">
      <div class="panel-heading"><div class="section-title-row"><h2 id="traffic-trend-title">${title}</h2>${A.titleInfo(title,
        `查看每天的${label}。未收到数据的日期不画柱子，明细用「—」表示。`, 'traffic-trend-help')}</div></div>
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

  function showOverview(workspace, report, site, { ipCount, visitorReport, loading }) {
    const overview = workspace.querySelector('[data-traffic-summary]');
    const storeVisitors = site !== renovation;
    const items = columns(site).map(([key, label, unit], index) => {
      const value = storeVisitors && key === 'visitors' ? visitorReport?.visitors : report?.summary?.[key];
      return [label, count(value), unit, index === 0 && validCount(value)];
    });
    if (site !== renovation) items.push(['独立 IP 数', count(ipCount), '个']);
    let meta = '';
    if (report && report.status !== 'unconfigured') meta = reportMeta(report, site);
    else if (visitorReport?.status === 'ready') {
      meta = `<div class="data-traffic-meta"><strong>${A.esc(visitorReport.from)} 至 ${A.esc(visitorReport.to)}</strong>` +
        '<span>统计时区 世界标准时间（UTC）</span></div>';
    }
    const source = site === renovation ? 'GA4' : 'Cloudflare';
    const message = loading ? '正在读取网站统计…' : report?.status === 'unconfigured'
      ? `该网站尚未接入 ${source} 统计。` : report?.status === 'empty' ? `该时段暂无 ${source} 访问数据。` : '';
    overview.innerHTML = meta + A.summary(items) + (message
      ? `<p class="data-traffic-message" role="status">${A.esc(message)}</p>` : '');
  }

  function showTrend(workspace, report, site, visitorReport, keepOpen = false) {
    const detail = workspace.querySelector('[data-traffic-detail]');
    const visitorTrend = visitorReport?.status === 'ready' && validCount(visitorReport.visitors);
    const analyticsDays = report?.status === 'ready' ? report.daily : [];
    if (!analyticsDays.length && !visitorTrend) {
      detail.replaceChildren();
      detail.hidden = true;
      return;
    }
    const metrics = columns(site);
    let daily = analyticsDays;
    if (visitorTrend) {
      const analyticsByDate = new Map(analyticsDays.map(row => [row.date, row.metrics]));
      daily = visitorReport.daily.map(({ date, visitors }) => ({
        date, metrics: { ...analyticsByDate.get(date), visitors }
      }));
    }
    const primary = metrics[site === renovation || visitorTrend ? 0 : 1];
    detail.innerHTML = renderTrend(daily, metrics, primary, keepOpen && Boolean(detail.querySelector('details[open]')));
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

  async function readUniqueIps(query) {
    const report = await data.websiteUniqueIps(query);
    if (report?.site !== query.site || report.from !== query.from || report.to !== query.to)
      throw new Error('Invalid website visits report');
    if (report.status === 'not-collected' && report.uniqueIps === null) return null;
    if (report.status !== 'ready' || !Number.isSafeInteger(report.uniqueIps) || report.uniqueIps < 0)
      throw new Error('Invalid website visits count');
    return report.uniqueIps;
  }

  async function readStorefrontVisitors(query) {
    const report = await data.websiteStorefrontVisitors(query);
    if (report?.site !== query.site || report.from !== query.from || report.to !== query.to)
      throw new Error('Invalid storefront visitor dates');
    if (report.status === 'unconfigured') return { ...query, status: report.status };
    const start = Date.parse(query.from), dayMs = 86_400_000;
    const days = (Date.parse(query.to) - start) / dayMs + 1;
    const validVisitors = value => value === null || validCount(value);
    if (report.status !== 'ready' || report.timeZone !== 'UTC' || !validVisitors(report.visitors) ||
        typeof report.hasUnidentifiedViews !== 'boolean' || !Array.isArray(report.daily) || report.daily.length !== days ||
        report.daily.some((row, index) => row?.date !== new Date(start + index * dayMs).toISOString().slice(0, 10) ||
          !validVisitors(row.visitors))) throw new Error('Invalid storefront visitor report');
    return report;
  }

  async function loadTraffic(workspace, selection, { refresh = false } = {}) {
    if (!workspace || !canRead()) return;
    const { site } = selection, dates = selectedDates(selection), query = { site, ...dates };
    const notice = workspace.querySelector('[data-traffic-notice]');
    const visitorNotice = workspace.querySelector('[data-traffic-visitor-notice]');
    const ipNotice = workspace.querySelector('[data-traffic-ip-notice]');
    const region = workspace.querySelector('[data-traffic-read]');
    const status = workspace.querySelector('[data-traffic-progress]');
    const key = JSON.stringify(query);
    const analytics = data.queries.peek(scope, query);
    const previous = analytics?.data;
    const visitors = site !== renovation ? data.queries.peek(visitorScope, query) : undefined;
    let report = previous;
    let visitorReport = visitors?.data;
    let ipCount = site !== renovation ? data.queries.peek(visitScope, query)?.data : undefined;
    let loading = !previous;
    const sameSelection = workspace.dataset.trafficKey === key;
    const updateOverview = () => showOverview(workspace, report, site, { ipCount, visitorReport, loading });
    const updateTrend = (keepOpen = true) => showTrend(workspace, report, site, visitorReport, keepOpen);
    if (!sameSelection) {
      workspace.dataset.trafficKey = key;
      updateOverview();
      updateTrend(false);
    }
    notice.hidden = true;
    visitorNotice.hidden = true;
    ipNotice.hidden = true;
    if (sameSelection && loading) updateOverview();
    const read = A.beginRegionRead(region, status, {
      refreshButton: workspace.querySelector('[data-action="data-traffic-refresh"]')
    });
    const current = () => read.current() && canRead();
    const readAnalytics = async () => {
      try {
        report = await data.queries.read(scope, query, () => readTrafficReport(site, dates), { refresh });
        if (!current()) return;
        if (refresh || analytics?.stale || analytics?.pending || !previous) updateTrend();
      } catch (error) {
        if (!current() || error.name === 'AbortError') return false;
        const denied = error.status === 401 || error.status === 403;
        const hasPrevious = !denied && previous && previous.status !== 'unconfigured';
        if (!hasPrevious) {
          report = null;
          updateTrend();
        }
        notice.textContent = denied ? '当前账号无权查看网站统计。' : hasPrevious
          ? '暂时无法更新，已保留上次读取的统计。' : '暂时读不到访问数据，请刷新统计。';
        notice.hidden = false;
      }
      loading = false;
      updateOverview();
    };
    const readVisitors = async () => {
      try {
        visitorReport = await data.queries.read(visitorScope, query, () => readStorefrontVisitors(query), { refresh });
        if (!current()) return;
        if (refresh || visitors?.stale || visitors?.pending || !visitors?.data) updateTrend();
        const message = visitorReport.status === 'unconfigured' ? '该商城尚未接入去重访客统计。'
          : visitorReport.visitors === null ? '所选日期没有可用的商城访客记录。'
          : visitorReport.hasUnidentifiedViews ? '部分商城访问缺少去重标识，访客数只包含可识别记录。' : '';
        visitorNotice.textContent = message;
        visitorNotice.hidden = !message;
      } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        const denied = error.status === 401 || error.status === 403;
        const hasPrevious = !denied && validCount(visitorReport?.visitors);
        if (!hasPrevious) {
          visitorReport = undefined;
          updateTrend();
        }
        visitorNotice.textContent = denied ? '当前账号无权查看商城访客数。' : hasPrevious
          ? '暂时无法更新商城访客数，已保留上次数据。' : '暂时无法读取商城访客数，请刷新统计。';
        visitorNotice.hidden = false;
      }
      updateOverview();
    };
    const readIps = async () => {
      try {
        ipCount = await data.queries.read(visitScope, query, () => readUniqueIps(query), { refresh });
        if (!current()) return true;
        updateOverview();
        if (ipCount === null) {
          ipNotice.textContent = '该时段尚无可用的独立 IP 采集数据。';
          ipNotice.hidden = false;
        }
        return true;
      } catch (error) {
        if (!current() || error.name === 'AbortError') return false;
        const denied = error.status === 401 || error.status === 403;
        if (denied) {
          ipCount = undefined;
          updateOverview();
        }
        ipNotice.textContent = denied ? '当前账号无权查看独立 IP 数。' : ipCount == null
          ? '暂时无法读取独立 IP 数，请刷新统计。' : '暂时无法更新独立 IP 数，已保留上次数据。';
        ipNotice.hidden = false;
        return false;
      }
    };
    try {
      if (site === renovation) return await readAnalytics();
      const [, ipsRead] = await Promise.all([readAnalytics(), readIps(), readVisitors()]);
      return !current() || ipsRead;
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
    onDataChanges(scopes) {
      const selection = filters();
      if (A.state.route !== trafficRoute || selection.site === renovation || !scopes.includes(visitScope)) return;
      return loadTraffic(document.querySelector('[data-traffic]'), selection);
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
