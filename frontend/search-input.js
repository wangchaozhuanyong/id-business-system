/* Shared automatic list search. Explicit submit forms and picker inputs opt out. */
(() => {
  'use strict';
  const pending = new Map(), compositions = new Set();
  let focusedSearch;
  let applied = new WeakMap();
  let applying = 0, deferredRender = false;
  const matches = node => node?.matches?.('input[data-auto-search]');
  const owner = node => {
    const A = window.IDDesignAPI;
    return JSON.stringify([A?.state.actor?.id, A?.state.route,
      node.closest('#drawer') ? A?.state.drawerContext : 'page', node.id]);
  };
  const visible = node => node.isConnected && !node.closest('[hidden]') &&
    (!node.closest('dialog') || node.closest('dialog').open);
  const remember = node => {
    const key = owner(node), previous = pending.get(key);
    clearTimeout(previous?.timer);
    const entry = { key, node, value: node.value, start: node.selectionStart, end: node.selectionEnd,
      appliedValue: previous?.appliedValue ?? applied.get(node) ?? node.defaultValue,
      focused: document.activeElement === node, due: Date.now() + 300 };
    pending.set(key, entry);
    return entry;
  };
  function commit(entry) {
    clearTimeout(entry?.timer);
    if (!entry || pending.get(entry.key) !== entry || owner(entry.node) !== entry.key ||
        !visible(entry.node) || compositions.has(entry.node)) return;
    const focused = document.activeElement;
    const previousFocus = focused !== entry.node ? { node: focused, id: focused.id,
      owner: owner(focused), start: focused.selectionStart, end: focused.selectionEnd } : null;
    pending.delete(entry.key);
    applied.set(entry.node, entry.value);
    applying++;
    try { entry.node.dispatchEvent(new Event('input', { bubbles: true })); }
    finally {
      applying--;
      if (deferredRender) { deferredRender = false; window.IDDesignAPI?.render(); }
      if (previousFocus) {
        const node = previousFocus.node.isConnected ? previousFocus.node : previousFocus.id &&
          [...document.querySelectorAll('#' + CSS.escape(previousFocus.id))].find(node => owner(node) === previousFocus.owner);
        if (node && visible(node)) {
          node.focus({ preventScroll: true });
          if (typeof previousFocus.start === 'number') node.setSelectionRange(previousFocus.start, previousFocus.end);
        }
      }
    }
  }
  function schedule(entry) {
    clearTimeout(entry.timer);
    if (compositions.has(entry.node)) return;
    if (!entry.value) commit(entry);
    else entry.timer = setTimeout(() => commit(entry), Math.max(0, entry.due - Date.now()));
  }
  document.addEventListener('input', event => {
    if (applying || !matches(event.target)) return;
    event.stopImmediatePropagation();
    const entry = remember(event.target);
    if (!event.isComposing) schedule(entry);
  }, true);
  document.addEventListener('change', event => {
    // A native blur/change must not bypass or duplicate the pending input commit.
    if (matches(event.target)) event.stopImmediatePropagation();
  }, true);
  document.addEventListener('compositionstart', event => {
    if (!matches(event.target)) return;
    compositions.add(event.target);
    remember(event.target);
  }, true);
  document.addEventListener('compositionend', event => {
    if (!matches(event.target)) return;
    compositions.delete(event.target);
    schedule(remember(event.target));
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !matches(event.target)) return;
    if (event.isComposing || event.keyCode === 229 || compositions.has(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    commit(remember(event.target));
  }, true);
  window.IDSearchInput = {
    value(node) { return pending.get(owner(node))?.appliedValue ?? node.value; },
    discardPage(route, id) {
      const key = JSON.stringify([window.IDDesignAPI?.state.actor?.id, route, 'page', id]);
      const entry = pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      compositions.delete(entry.node);
      pending.delete(key);
    },
    // Do not replace an IME's live input node during a background render.
    deferRender(root) {
      for (const node of compositions) if (visible(node) && root.contains(node)) {
        deferredRender = true;
        return true;
      }
      deferredRender = false;
      return false;
    },
    suspend(root) {
      const focused = document.activeElement;
      focusedSearch = matches(focused) && root.contains(focused)
        ? { key: owner(focused), start: focused.selectionStart, end: focused.selectionEnd } : undefined;
      for (const entry of pending.values()) if (root.contains(entry.node)) {
        clearTimeout(entry.timer);
        entry.focused = document.activeElement === entry.node;
        entry.start = entry.node.selectionStart;
        entry.end = entry.node.selectionEnd;
        // Leaving a view ends its composition, but keeps the ordinary raw query.
        compositions.delete(entry.node);
      }
    },
    restore(root) {
      const focus = focusedSearch;
      focusedSearch = undefined;
      for (const node of root.querySelectorAll('input[data-auto-search]')) {
        const key = owner(node);
        const entry = pending.get(key);
        applied.set(node, entry?.appliedValue ?? node.value);
        if (!visible(node)) continue;
        if (!entry) {
          if (focus?.key === key) {
            node.focus({ preventScroll: true });
            if (focus.start !== null) node.setSelectionRange(focus.start, focus.end);
          }
          continue;
        }
        entry.node = node;
        node.value = entry.value;
        if (entry.focused) {
          node.focus({ preventScroll: true });
          if (entry.start !== null) node.setSelectionRange(entry.start, entry.end);
        }
        schedule(entry);
      }
    },
    clear() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear(); compositions.clear(); deferredRender = false;
      focusedSearch = undefined;
      applied = new WeakMap();
    }
  };
})();
