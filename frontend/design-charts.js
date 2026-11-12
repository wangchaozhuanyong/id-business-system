/* 只读展示；金额的汇总与核算继续由原业务模块提供。 */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const tones = ['blue', 'teal', 'violet', 'amber', 'cyan', 'danger'];
  const tone = value => tones.includes(value) ? value : 'blue';
  let sequence = 0;
  function numeric(value) {
    if (value === null || value === undefined || value === '' || value === '—') return null;
    const number = Number(String(value).replaceAll(',', ''));
    return Number.isFinite(number) ? number : null;
  }
  function bars({ title, rows, series, unit = '', details = true }) {
    const id = `id-chart-${++sequence}`;
    const values = rows.flatMap(row => series.map(s => numeric(row[s.key]))).filter(v => v !== null);
    if (!values.length) return `<div class="design-chart-empty" role="status">暂无可绘制数据</div>`;
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const rawStep = (high - low || 1) / 3;
    const scale = 10 ** Math.floor(Math.log10(rawStep));
    const integerUnit = ['笔', '位', '条'].includes(unit);
    const step = Math.max(integerUnit ? 1 : scale, Math.ceil(rawStep / scale) * scale);
    const min = Math.floor(low / step) * step, max = Math.max(step, Math.ceil(high / step) * step);
    const y = value => 200 - (value - min) / (max - min) * 180;
    const zero = y(0), slot = 604 / Math.max(1, rows.length);
    const width = Math.min(28, slot * .75 / series.length);
    const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + step * i);
    const label = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: integerUnit ? 0 : 2, notation: 'compact' }).format(value);
    const legend = `<div class="design-chart-legend">${series.map(s => `<span data-tone="${tone(s.tone)}"><i aria-hidden="true"></i>${esc(s.label)}</span>`).join('')}</div>`;
    const grid = ticks.map(v => `<path class="design-chart-grid" d="M56 ${y(v)}H660"/><text class="design-chart-tick" x="48" y="${y(v) + 4}" text-anchor="end">${esc(label(v))}</text>`).join('');
    const marks = rows.map((row, index) => {
      const center = 56 + slot * (index + .5);
      const description = `${row.label}；` + series.map(s => `${s.label} ${row[s.key] ?? '未取得'}${unit ? ' ' + unit : ''}`).join('；');
      return `<g data-chart-point data-chart-label="${esc(description)}" tabindex="${index ? -1 : 0}" role="img" aria-label="${esc(description)}" aria-describedby="${id}-tooltip"><title>${esc(description)}</title><rect class="design-chart-hit" x="${56 + slot * index}" y="16" width="${slot}" height="188"/>${series.map((s, j) => {
        const value = numeric(row[s.key]);
        return value === null ? '' : `<rect data-tone="${tone(s.tone)}" class="design-chart-bar" x="${center + (j - series.length / 2) * width}" y="${Math.min(zero, y(value))}" width="${Math.max(1, width - 2)}" height="${Math.max(value === 0 ? 0 : 1, Math.abs(zero - y(value)))}" rx="2"/>`;
      }).join('')}</g>${rows.length <= 8 || index % Math.ceil(rows.length / 7) === 0 || index === rows.length - 1 ? `<text class="design-chart-tick" data-mobile-tick="${[0, Math.floor(rows.length / 2), rows.length - 1].includes(index) ? 'major' : 'minor'}" x="${center}" y="224" text-anchor="middle">${esc(row.shortLabel || row.label)}</text>` : ''}`;
    }).join('');
    const table = `<details class="design-chart-details"><summary>查看图表数据</summary><div class="design-chart-data"><table><caption>${esc(title)}${unit ? ' · ' + esc(unit) : ''}</caption><thead><tr><th scope="col">项目</th>${series.map(s => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${esc(row.label)}</th>${series.map(s => `<td>${esc(row[s.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    return `<div class="design-chart">${legend}<div class="design-chart-plot"><svg viewBox="0 0 680 240" role="group" aria-label="${esc(title)}${unit ? '，单位 ' + esc(unit) : ''}">${grid}<path class="design-chart-axis" d="M56 ${zero}H660"/>${marks}</svg><div id="${id}-tooltip" class="design-chart-tooltip" role="tooltip" hidden></div></div>${details ? table : ''}</div>`;
  }
  function comparison(label, items) {
    const values = items.map(item => numeric(item.value));
    if (values.some(value => value === null || value < 0))
      return '<span class="design-chart-unavailable">数据待核验</span>';
    const max = Math.max(0, ...values);
    const description = `${label}：` + items.map(item => `${item.label} ${item.value}`).join('，');
    // Independent bars: claimed and abnormal stock can overlap, so they are not percentages.
    return `<div class="design-stock-comparison" role="img" aria-label="${esc(description)}">${max ? `<svg viewBox="0 0 100 ${items.length * 7}" preserveAspectRatio="none" aria-hidden="true">${items.map((item, index) => `<rect class="design-stock-track" y="${index * 7}" width="100" height="4" rx="2"/><rect data-tone="${tone(item.tone)}" y="${index * 7}" width="${values[index] / max * 100}" height="4" rx="2"><title>${esc(item.label + ' ' + item.value)}</title></rect>`).join('')}</svg>` : '<span>暂无记录</span>'}</div>`;
  }
  function show(point) {
    const plot = point.closest('.design-chart-plot'), tip = plot?.querySelector('.design-chart-tooltip');
    if (!tip) return;
    plot.removeAttribute('data-chart-dismissed');
    plot.querySelectorAll('[data-chart-point][data-chart-dismissed]').forEach(p => p.removeAttribute('data-chart-dismissed'));
    hideAll(tip);
    tip.textContent = point.dataset.chartLabel;
    tip.hidden = false;
    const p = plot.getBoundingClientRect(), a = point.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(a.x - p.x + a.width / 2 - tip.offsetWidth / 2, p.width - tip.offsetWidth - 4))}px`;
    tip.style.top = '4px';
  }
  function hide(point) { const tip = point?.closest('.design-chart-plot')?.querySelector('.design-chart-tooltip'); if (tip) tip.hidden = true; }
  function hideAll(except) {
    document.querySelectorAll('.design-chart-tooltip:not([hidden])').forEach(tip => {
      if (tip !== except) tip.hidden = true;
    });
  }
  function dismissAll() {
    document.querySelectorAll('.design-chart-tooltip:not([hidden])').forEach(tip => {
      const plot = tip.closest('.design-chart-plot');
      // Hiding a hovered popup exposes the point underneath. Suppress that
      // synthetic re-entry until the pointer leaves the newly exposed point.
      const hovered = tip.matches(':hover') ? plot : plot.querySelector('[data-chart-point]:hover');
      hovered?.setAttribute('data-chart-dismissed', '');
      tip.hidden = true;
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const p = event.target.closest?.('[data-chart-point]');
      if (!p) return;
      const plot = p.closest('.design-chart-plot');
      if (plot.hasAttribute('data-chart-dismissed')) {
        plot.removeAttribute('data-chart-dismissed');
        p.setAttribute('data-chart-dismissed', '');
      }
      if (!p.hasAttribute('data-chart-dismissed')) show(p);
    });
    document.addEventListener('pointerout', event => {
      if (event.pointerType === 'touch') return;
      const p = event.target.closest?.('[data-chart-point]');
      const tip = event.target.closest?.('.design-chart-tooltip');
      const next = event.relatedTarget;
      if (p && !p.contains(next)) p.removeAttribute('data-chart-dismissed');
      if (p && !p.contains(next) && !p.closest('.design-chart-plot').querySelector('.design-chart-tooltip')?.contains(next)) hide(p);
      if (tip && !tip.contains(next) && !next?.closest?.('[data-chart-point]')) {
        tip.hidden = true;
        tip.closest('.design-chart-plot').removeAttribute('data-chart-dismissed');
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest?.('[data-chart-point], .design-chart-tooltip')) hideAll();
    });
    // Touch has no persistent hover. Keep the selected value visible until the
    // next point, an outside press or Escape; delegation survives chart redraws.
    document.addEventListener('click', event => {
      const p = event.target.closest?.('[data-chart-point]');
      if (p) show(p);
    });
    document.addEventListener('focusin', event => { const p = event.target.closest?.('[data-chart-point]'); if (p) show(p); });
    document.addEventListener('focusout', event => {
      const p = event.target.closest?.('[data-chart-point]');
      const tip = p?.closest('.design-chart-plot')?.querySelector('.design-chart-tooltip');
      if (p && !tip?.matches(':hover') && !tip?.contains(event.relatedTarget)) hide(p);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { dismissAll(); return; }
      const point = event.target.closest?.('[data-chart-point]');
      if (!point) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const points = [...point.closest('svg').querySelectorAll('[data-chart-point]')], i = points.indexOf(point);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)));
      points.forEach((p, index) => p.setAttribute('tabindex', index === next ? '0' : '-1'));
      points[next].focus();
      show(points[next]);
    });
    window.addEventListener('resize', () => hideAll());
  }
  window.IDCharts = { bars, comparison };
})();
