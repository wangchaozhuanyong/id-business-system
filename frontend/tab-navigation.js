/* Horizontal navigation in the workspace, drawers and standalone shells. */
(() => {
  'use strict';
  const bars = '.tabs, .entry-mobile-tabs, .subscription-center-nav, .completion-status-filters';
  const selected = '.active, [aria-selected="true"], [aria-pressed="true"], [aria-current="page"]';
  const controls = bar => Array.from(bar.children).filter(node => node.matches('button, a[href], [role="tab"]'));
  const activeTab = bar => controls(bar).find(node => node.matches(selected));
  const scrollport = bar => bar.parentElement?.matches('[data-tab-scrollport]') ? bar.parentElement : bar;
  const key = (bar, index) => bar.getAttribute('aria-label') || bar.id ||
    (bar.querySelector('[data-action]')?.dataset.action || 'tabs') + ':' + index;

  function reveal(bar, tab = activeTab(bar)) {
    if (!tab || !bar.isConnected) return;
    const port = scrollport(bar);
    if (!port.clientWidth || port.scrollWidth <= port.clientWidth + 1) return;
    const box = port.getBoundingClientRect(), item = tab.getBoundingClientRect();
    // Centering also brings the adjacent navigation into reach. Native scrolling clamps both ends.
    port.scrollLeft += item.left - box.left - port.clientLeft + (item.width - port.clientWidth) / 2;
  }

  function capture(root) {
    return new Map(Array.from(root.querySelectorAll(bars), (bar, index) => {
      const items = controls(bar);
      return [key(bar, index), { left: scrollport(bar).scrollLeft, selected: items.indexOf(activeTab(bar)),
        focus: items.indexOf(document.activeElement) }];
    }));
  }
  function restore(root, saved, restoreFocus = true) {
    root.querySelectorAll(bars).forEach((bar, index) => {
      const previous = saved?.get(key(bar, index));
      const items = controls(bar), tab = activeTab(bar);
      if (previous && items.indexOf(tab) === previous.selected) scrollport(bar).scrollLeft = previous.left;
      else reveal(bar, tab);
      if (restoreFocus && previous?.focus >= 0 && document.activeElement === document.body) {
        items[previous.focus]?.focus({ preventScroll: true });
      }
    });
  }

  const installed = new WeakSet();
  function attach(page) {
    if (installed.has(page)) return;
    installed.add(page);
    page.addEventListener('click', event => {
      const tab = event.target.closest?.('button,a[href],[role="tab"]'), bar = tab?.parentElement;
      if (!bar?.matches(bars)) return;
      // In-place switches set their selected state in their own handlers. Full page renders call restore().
      page.defaultView.requestAnimationFrame(() => { if (tab.isConnected && tab.matches(selected)) reveal(bar, tab); });
    }, true);

    page.defaultView.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tab = event.target.closest?.('[role="tab"], button[aria-pressed]');
      const bar = tab?.parentElement;
      if (!bar?.matches(bars)) return;
      const items = controls(bar).filter(node => !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length);
      const index = items.indexOf(tab);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
      items[next].click();
    });
  }

  function attachWorkspace(page) {
    if (!page?.querySelector('.tab-nav.tabs') || installed.has(page)) return;
    const style = page.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/tab-navigation.css?v=20261119-workspace-tabs';
    page.head.append(style);
    attach(page);
  }

  attach(document);
  window.IDTabNavigation = { capture, restore, reveal, attachWorkspace };
})();
