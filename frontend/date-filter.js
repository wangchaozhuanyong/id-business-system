/* Shared date presets and custom range drawer for read-only filters. */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const esc = A.esc;
  const day = 86_400_000;
  const businessZone = 'Asia/Shanghai';
  const choices = [
    ['today', '今日', 1], ['yesterday', '昨日', 1], ['three', '近 3 天', 3],
    ['week', '近 7 天', 7], ['fifteen', '近 15 天', 15], ['month', '近 30 天', 30]
  ];
  const presets = choices.map(([id, label]) => [id, label]);
  const settings = new Map();
  const formatters = new Map();
  const drawer = document.getElementById('date-filter-drawer');
  let opened;

  function calendarDate(at, timeZone) {
    if (!formatters.has(timeZone))
      formatters.set(timeZone, new Intl.DateTimeFormat('sv-SE', { timeZone }));
    return formatters.get(timeZone).format(at);
  }

  function shift(date, days) {
    return new Date(Date.parse(date + 'T00:00:00Z') + days * day).toISOString().slice(0, 10);
  }

  function range(preset, now = Date.now(), timeZone = businessZone) {
    const days = choices.find(([id]) => id === preset)?.[2];
    if (!days) return { from: '', to: '' };
    const today = calendarDate(now, timeZone);
    const to = preset === 'yesterday' ? shift(today, -1) : today;
    return { from: shift(to, 1 - days), to };
  }

  function render({
    id, value = '', from = '', to = '', all = false, compact = false, label = '时间范围',
    min = '', max = '', allowOpen = false, maxDays, disabled = false, now, timeZone = businessZone, onSelect
  }) {
    const options = { id, value, from, to, min, max, allowOpen, maxDays, now, timeZone, onSelect };
    settings.set(id, options);
    const items = (all ? [['all', '全部时间'], ...presets] : presets).map(([key, title]) => {
      const dates = range(key, now, timeZone);
      return [key, title, { disabled: Boolean(dates.from && (dates.from < min || (max && dates.to > max))) }];
    });
    const custom = value === 'custom';
    const selectedText = custom
      ? from && to ? from + ' 至 ' + to : from ? from + ' 起' : '截至 ' + to
      : '';
    const customDescription = selectedText ? ' title="' + esc(selectedText) + '"' : '';
    const selectedOption = custom ? ['custom', '已选自定义区间', { disabled: true }] : ['', '选择时间', { disabled: true }];
    return `<div class="id-date-filter${compact ? ' id-date-filter-compact' : ''}" data-date-filter="${esc(id)}">
      <div class="id-date-presets" role="group" aria-label="${esc(label)}">
        ${items.map(([key, title, state]) => `<button type="button" class="button${value === key ? ' primary' : ''}"
          data-date-choice="${key}" aria-pressed="${value === key}"${disabled || state.disabled ? ' disabled' : ''}>${title}</button>`).join('')}
        <button type="button" class="button${custom ? ' primary' : ''}" data-date-choice="choose-custom"
          aria-haspopup="dialog" aria-controls="date-filter-drawer" aria-pressed="${custom}"${customDescription}${disabled ? ' disabled' : ''}>自定义日期</button>
      </div>
      <select class="id-date-select" id="${esc(id)}-select" aria-label="${esc(label)}" data-date-select
        ${customDescription}${disabled ? ' disabled' : ''}>${A.options([selectedOption, ...items, ['choose-custom', '自定义日期']], value)}</select>
      ${selectedText ? `<span class="id-date-applied">${esc(selectedText)}</span>` : ''}
    </div>`;
  }

  function currentControl(id, choice) {
    const roots = document.querySelectorAll(`[data-date-filter="${CSS.escape(id)}"]`);
    const root = [...roots].find(node => node.getClientRects().length);
    const button = root?.querySelector(`[data-date-choice="${choice}"]`);
    return button?.getClientRects().length ? button : root?.querySelector('[data-date-select]');
  }

  function restoreFocus(id, choice) {
    const control = currentControl(id, choice);
    if (control?.getClientRects().length) control.focus({ preventScroll: true });
  }

  function captureFocus(region) {
    const control = document.activeElement;
    if (!region?.contains(control) || !control.matches('[data-date-choice], [data-date-select]')) return;
    const choice = control.dataset.dateChoice || control.value;
    const { dateFilter } = control.closest('[data-date-filter]').dataset;
    return () => {
      if (!control.isConnected && document.activeElement === document.body)
        restoreFocus(dateFilter, choice === 'custom' ? 'choose-custom' : choice);
    };
  }

  function select(options, preset, dates = range(preset, options.now, options.timeZone)) {
    options.onSelect({ preset, ...dates });
    restoreFocus(options.id, preset === 'custom' ? 'choose-custom' : preset);
  }

  function open(options) {
    const { id, value, from, to, min, max, allowOpen, now, timeZone } = options;
    const fromId = id + '-from';
    const toId = id + '-to';
    const fallback = range('today', now, timeZone).to;
    const dateAttrs = 'type="date"' + (min ? ` min="${esc(min)}"` : '') +
      (max ? ` max="${esc(max)}"` : '') + (allowOpen ? '' : ' required');
    const selected = range(value, now, timeZone);
    const defaults = value === 'custom' || (value === 'all' && allowOpen) ? { from, to } : {
      from: selected.from || from || fallback,
      to: selected.to || to || fallback
    };
    opened = options;
    drawer.innerHTML = `<header class="drawer-header">
      <div class="drawer-title-row"><h2 id="date-filter-title">选择统计日期</h2></div>
      <button type="button" class="icon-button" data-date-dismiss aria-label="关闭抽屉">${A.icon('close')}</button>
    </header>
    <div class="drawer-body">
      <form id="date-filter-form" novalidate>
        ${A.field('开始日期', fromId, A.input(fromId, defaults.from, dateAttrs + ' aria-label="开始日期"'), !allowOpen)}
        ${A.field('结束日期', toId, A.input(toId, defaults.to, dateAttrs + ' aria-label="结束日期"'), !allowOpen)}
        <p class="footnote">${timeZone === 'UTC' ? 'UTC' : timeZone === 'Asia/Shanghai' || timeZone === 'Asia/Kuala_Lumpur' ? '北京时间' : esc(timeZone)}，包含起止日。
          ${allowOpen ? '可以只设开始或结束日期。' : ''}Tab 切换，Enter 应用，Esc 取消。</p>
      </form>
    </div>
    <footer class="drawer-footer">
      <button type="button" class="button" data-date-dismiss>取消</button>
      <button type="submit" class="button primary" form="date-filter-form">应用日期</button>
    </footer>`;
    drawer.showModal();
    drawer.querySelector('input').focus({ preventScroll: true });
  }

  function close() {
    const options = opened;
    opened = undefined;
    drawer.close();
    if (options) restoreFocus(options.id, 'choose-custom');
  }

  function fieldError(input, label, options) {
    const value = input.value;
    if (input.validity.badInput || (value && !/^\d{4}-\d{2}-\d{2}$/.test(value))) return '请选择有效的' + label;
    if (!value && !options.allowOpen) return '请选择' + label;
    if (value && options.min && value < options.min) return label + '不能早于 ' + options.min;
    if (value && options.max && value > options.max) return label + '不能晚于 ' + options.max;
    return '';
  }

  drawer.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!opened) return;
    const options = opened;
    const [start, end] = event.target.querySelectorAll('input');
    const from = start.value;
    const to = end.value;
    const startError = fieldError(start, '开始日期', options) ||
      (options.allowOpen && !from && !to && !end.validity.badInput ? '请至少选择一个日期' : '');
    let endError = fieldError(end, '结束日期', options);
    if (!startError && !endError && from && to) {
      if (to < from) endError = '结束日期不能早于开始日期';
      else if (options.maxDays && to > shift(from, options.maxDays - 1)) endError = '日期范围最多 ' + options.maxDays + ' 天';
    }
    A.setError(start.id, startError, drawer);
    A.setError(end.id, endError, drawer);
    if (startError || endError) {
      (startError ? start : end).focus();
      return;
    }
    close();
    select(options, 'custom', { from, to });
  });
  drawer.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  drawer.addEventListener('click', event => {
    if (event.target.closest('[data-date-dismiss]')) close();
  });
  A.dismissOnBackdrop(drawer, close);

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-date-choice]');
    if (!button || button.disabled) return;
    const options = settings.get(button.closest('[data-date-filter]').dataset.dateFilter);
    const preset = button.dataset.dateChoice;
    if (preset === 'choose-custom') open(options);
    else select(options, preset);
  });

  document.addEventListener('change', event => {
    const node = event.target;
    if (!node.matches('[data-date-select]')) return;
    const options = settings.get(node.closest('[data-date-filter]').dataset.dateFilter);
    if (node.value === 'choose-custom') {
      node.value = options.value;
      open(options);
    } else select(options, node.value);
  });

  document.addEventListener('keydown', event => {
    const button = event.target.closest('[data-date-choice]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...button.parentElement.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  });

  function dismiss() {
    if (drawer.open) close();
  }

  window.IDDateFilter = { presets, range, render, captureFocus, dismiss };
})();
