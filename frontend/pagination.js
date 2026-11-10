(() => {
  'use strict';

  const defaultPageSize = 20;
  const pageSizes = Object.freeze([10, 20, 50]);
  const numberFormat = new Intl.NumberFormat('zh-CN');
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function pageNumbers(page, lastPage) {
    if (lastPage <= 7) return Array.from({ length: lastPage }, (_, index) => index + 1);
    const start = Math.min(lastPage - 5, Math.max(2, page - 2));
    const numbers = [1, ...Array.from({ length: 5 }, (_, index) => start + index), lastPage];
    return numbers.flatMap((number, index) =>
      index && number - numbers[index - 1] > 1 ? [null, number] : [number]);
  }

  function render({ id, page = 1, pageSize = defaultPageSize, total, pageSizes: sizes = pageSizes, disabled = false }) {
    total = Number.isSafeInteger(total) && total > 0 ? total : 0;
    pageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : defaultPageSize;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    page = Math.max(1, Math.min(Number.isSafeInteger(page) ? page : 1, lastPage));
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    const disabledAttribute = disabled ? 'disabled' : '';
    const sizeControl = sizes.length
      ? `<select data-pagination-size aria-label="每页条数" ${disabledAttribute}>
          ${sizes.includes(pageSize) ? '' : `<option value="${pageSize}" selected disabled>${pageSize}条/页</option>`}
          ${sizes.map((size) => `<option value="${size}" ${size === pageSize ? 'selected' : ''}>${size}条/页</option>`).join('')}
        </select>`
      : '';
    const nav = lastPage > 1 ? `
      <button type="button" data-pagination-page="${page - 1}" data-pagination-nav="previous" aria-label="上一页" ${disabled || page <= 1 ? 'disabled' : ''}><span class="pagination-nav-label">上一页</span><span class="pagination-nav-icon" aria-hidden="true">‹</span></button>
      <div class="pagination-pages" role="group" aria-label="页码">
        ${pageNumbers(page, lastPage).map((number) => number === null
          ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
          : `<button type="button" data-pagination-page="${number}" data-page="${number}" ${number === page ? 'aria-current="page"' : ''} ${disabledAttribute}>${number}</button>`).join('')}
      </div>
      <details class="pagination-jump">
        <summary aria-label="当前第 ${page} / ${lastPage} 页，跳至指定页">
          <span class="pagination-jump-desktop">跳页</span><span class="pagination-jump-compact">${page} / ${lastPage}</span>
        </summary>
        <div class="pagination-jump-controls">
          <label>页码 <input data-pagination-target aria-label="跳至页码" type="number" inputmode="numeric" min="1" max="${lastPage}" step="1" value="${page}" required ${disabledAttribute}></label>
          <button type="button" data-pagination-jump ${disabledAttribute}>跳转</button>
        </div>
      </details>
      <button type="button" data-pagination-page="${page + 1}" data-pagination-nav="next" aria-label="下一页" ${disabled || page >= lastPage ? 'disabled' : ''}><span class="pagination-nav-label">下一页</span><span class="pagination-nav-icon" aria-hidden="true">›</span></button>` : '';
    return `<nav class="pagination id-pagination" aria-label="分页" aria-disabled="${disabled}" data-pagination="${escape(id)}" data-total="${total}" data-page="${page}" data-page-size="${pageSize}">
      <div class="pagination-inner">
        <span class="pagination-count" role="status">共 ${numberFormat.format(total)} 条${total ? ` · 第 ${numberFormat.format(start)}–${numberFormat.format(end)} 条` : ''}</span>
        <div class="pagination-controls" ${disabled ? 'inert' : ''}>${sizeControl}${nav}</div>
      </div>
    </nav>`;
  }

  function change(pager, page, pageSize, source) {
    const previousPage = Number(pager.dataset.page);
    const previousSize = Number(pager.dataset.pageSize);
    if (pager.getAttribute('aria-disabled') === 'true' || (page === previousPage && pageSize === previousSize)) return;
    const selector = source.matches('[data-pagination-size]') ? '[data-pagination-size]'
      : source.dataset.paginationNav ? `[data-pagination-nav="${source.dataset.paginationNav}"]`
      : source.closest('.pagination-jump') ? '.pagination-jump summary'
      : '[aria-current="page"]';
    const restoreFocus = pager.contains(document.activeElement);
    pager.dispatchEvent(new CustomEvent('id-pagination-change', {
      bubbles: true,
      detail: { id: pager.dataset.pagination, page, pageSize }
    }));
    if (!restoreFocus || pager.isConnected || document.activeElement !== document.body) return;
    const next = [...document.querySelectorAll('nav[data-pagination]')].find((candidate) =>
      candidate.dataset.pagination === pager.dataset.pagination && candidate.getClientRects().length);
    const target = next?.querySelector(selector);
    const fallback = next?.querySelector('.pagination-jump summary') || next?.querySelector('[data-pagination-size]');
    (target && !target.disabled && target.getClientRects().length ? target : fallback)
      ?.focus({ preventScroll: true });
  }

  // Keep only measured geometry. The caller owns and clears this map with its page lifecycle.
  function preserveFrame(root, frames, scope = '') {
    const pager = root?.querySelector('[data-pagination]');
    const viewport = [...root?.querySelectorAll('.table-viewport, [data-pagination-rows]') || []]
      .find(node => node.getClientRects().length);
    if (!pager || !viewport?.firstElementChild) return;
    const width = Math.round(viewport.getBoundingClientRect().width);
    if (!width) return;
    const key = `${scope}:${pager.dataset.pageSize}:${width}:${viewport.hasAttribute('data-pagination-rows') ? 'cards' : 'table'}`;
    const style = getComputedStyle(viewport);
    const content = viewport.querySelector('table') || viewport.firstElementChild;
    const contentHeight = content.getBoundingClientRect().height +
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + viewport.offsetHeight - viewport.clientHeight;
    const previous = frames.get(key);
    const frame = { rows: Math.max(previous?.rows || 0, contentHeight),
      footer: Math.max(previous?.footer || 0, pager.getBoundingClientRect().height) };
    frames.set(key, frame);
    const limit = 'var(--pagination-rows-limit)';
    viewport.style.minHeight = `min(${frame.rows}px, ${limit})`;
    viewport.style.maxHeight = limit;
    pager.style.minHeight = `${frame.footer}px`;
  }

  function closeJump(details) {
    details.open = false;
    details.querySelector('summary').focus({ preventScroll: true });
  }

  function jump(pager, source) {
    const details = source.closest('.pagination-jump');
    const control = details.querySelector('[data-pagination-target]');
    if (!control.reportValidity()) return;
    closeJump(details);
    change(pager, control.valueAsNumber, Number(pager.dataset.pageSize), source);
  }

  const pagedViewport = [
    '.table-viewport:has(~ .id-pagination, ~ [data-pagination-footer])',
    '[data-pagination-rows]',
    '[data-pagination-table] > .table-viewport'
  ].join(', ');

  function bottomInset(start, stop) {
    let inset = 0;
    for (let node = start; node && node !== stop; node = node.parentElement) {
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      inset += parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
    }
    return inset;
  }

  function watchTableLayout(root, { hostFrame = null, rows = pagedViewport } = {}) {
    if (!root) return;
    const host = hostFrame?.ownerDocument.defaultView || window;
    const main = hostFrame ? hostFrame.closest('main') : root.matches('main') ? root : null;
    const footer = main?.nextElementSibling?.matches('.workspace-footer') ? main.nextElementSibling : null;
    const stop = root === main ? root : root.parentElement;
    let applied = new Set(), pending = 0;

    function measure() {
      if (hostFrame && !hostFrame.getClientRects().length) return;
      const frames = [];
      const scope = root.querySelector(':scope > [data-page-region]:not([hidden]), .page-view.active') || root;
      if (host.innerWidth > 900) {
        const scroll = window.scrollY + root.scrollTop;
        const frameOffset = hostFrame ? hostFrame.getBoundingClientRect().top + host.scrollY : 0;
        const hostInset = main ? bottomInset(hostFrame?.parentElement || main, main.parentElement) : 0;
        const end = host.innerHeight - (footer?.offsetHeight || 0) - hostInset - frameOffset;
        const split = scope.querySelector('.commerce-entry-columns');
        if (split) {
          const top = split.getBoundingClientRect().top + scroll;
          frames.push([split, 'workspace', Math.max(400, Math.floor(end - top - bottomInset(split.parentElement, stop)))]);
        }

        const viewports = [...scope.querySelectorAll(rows)].filter((view) =>
          view.getClientRects().length && !view.closest('.commerce-entry-columns, dialog, [role="dialog"]')
        );
        for (const view of viewports) {
          const panel = view.closest('.panel') || view.parentElement;
          const box = view.getBoundingClientRect(), panelBox = panel.getBoundingClientRect();
          const below = panelBox.bottom - box.bottom + bottomInset(panel.parentElement, stop);
          const primary = viewports.length === 1;
          // Secondary panels may start below the fold. Budget from their own top.
          const top = primary ? box.top + scroll : box.top - panelBox.top;
          frames.push([view, primary ? 'fill' : 'limit', Math.max(220, Math.floor(end - top - below))]);
        }
      }

      const current = new Set(frames.map(([node]) => node));
      for (const node of applied) {
        if (current.has(node)) continue;
        delete node.dataset.paginationLayout;
        node.style.removeProperty('--pagination-rows-limit');
      }
      for (const [node, mode, height] of frames) {
        const value = height + 'px';
        if (node.dataset.paginationLayout !== mode) node.dataset.paginationLayout = mode;
        if (node.style.getPropertyValue('--pagination-rows-limit') !== value)
          node.style.setProperty('--pagination-rows-limit', value);
      }
      applied = current;
    }

    const schedule = () => {
      if (pending) return;
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        measure();
      });
    };
    const size = new ResizeObserver(schedule);
    size.observe(root);
    if (footer) size.observe(footer);
    if (hostFrame) size.observe(hostFrame.parentElement);
    // Size replacement rows and pagination together before the next paint.
    const content = new MutationObserver(measure);
    content.observe(root, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'data-pagination-rows']
    });
    host.addEventListener('resize', schedule);
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      host.removeEventListener('resize', schedule);
      size.disconnect();
      content.disconnect();
      if (pending) window.cancelAnimationFrame(pending);
    });
    measure();
    return measure;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-pagination-page], button[data-pagination-jump]');
    const pager = button?.closest('nav[data-pagination]');
    if (!pager || button.disabled) return;
    if (button.hasAttribute('data-pagination-jump')) jump(pager, button);
    else change(pager, Number(button.dataset.paginationPage), Number(pager.dataset.pageSize), button);
  });

  document.addEventListener('change', (event) => {
    const control = event.target.closest('select[data-pagination-size]');
    const pager = control?.closest('nav[data-pagination]');
    if (!pager || control.disabled) return;
    const nextSize = Number(control.value);
    // The selected size describes the rows that are currently visible.
    control.value = pager.dataset.pageSize;
    change(pager, 1, nextSize, control);
  });

  document.addEventListener('pointerdown', (event) => {
    for (const details of document.querySelectorAll('.id-pagination .pagination-jump[open]'))
      if (!details.contains(event.target)) details.open = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const details = event.target.closest('.id-pagination .pagination-jump[open]');
      if (!details) return;
      event.preventDefault();
      closeJump(details);
      return;
    }
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('[data-pagination-target]')) return;
    const pager = event.target.closest('nav[data-pagination]');
    if (!pager) return;
    event.preventDefault();
    jump(pager, event.target);
  });

  window.IDPagination = Object.freeze({ defaultPageSize, pageSizes, render, watchTableLayout, preserveFrame });
})();
