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

  window.IDPagination = Object.freeze({ defaultPageSize, pageSizes, render });
})();
