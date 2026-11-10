/* Session-only, opt-in feedback. Audio never carries information on its own. */
(() => {
  'use strict';
  const root = document.getElementById('interaction-preferences');
  if (!root) return;
  const panel = document.getElementById('sound-settings');
  const enabledInput = document.getElementById('sound-enabled');
  const volumeInput = document.getElementById('sound-volume');
  const label = root.querySelector('[data-sound-label]');
  const status = document.getElementById('sound-state');
  let enabled = false, volume = 0.15, context, lastPlayed = -Infinity, hoverTimer, activation = 0;
  const sounds = { hover: [480, 0.022], click: [580, 0.035], success: [740, 0.075], error: [310, 0.065] };
  function sync(message) {
    enabledInput.checked = enabled;
    label.textContent = enabled ? '音效开' : '音效关';
    root.dataset.enabled = String(enabled);
    document.getElementById('sound-volume-label').textContent = Math.round(volume * 100) + '%';
    if (message) status.textContent = message;
  }
  function disable(message = '默认静音，仅在本次会话开启。') {
    activation++;
    enabled = false;
    clearTimeout(hoverTimer);
    void context?.suspend().catch(() => {});
    sync(message);
  }
  function play(kind) {
    const sound = sounds[kind];
    if (!sound || !enabled || !volume || document.hidden || context?.state !== 'running') return false;
    const now = performance.now();
    // Hover feedback cannot chatter while moving between nearby controls.
    if (now - lastPlayed < (kind === 'hover' ? 300 : 65)) return false;
    lastPlayed = now;
    try {
      const oscillator = context.createOscillator(), gain = context.createGain();
      const start = context.currentTime, duration = sound[1];
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(sound[0], start);
      oscillator.frequency.exponentialRampToValueAtTime(sound[0] * 0.85, start + duration);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume * (kind === 'hover' ? 0.08 : 0.18), start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
      return true;
    } catch { disable('音频暂不可用，页面操作不受影响。'); return false; }
  }
  enabledInput.addEventListener('change', async event => {
    if (!enabledInput.checked) return disable('音效已关闭。');
    if (!event.isTrusted) return disable();
    const version = ++activation;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('unavailable');
      context ??= new Audio();
      await context.resume();
      if (version !== activation) return;
      if (context.state !== 'running') throw new Error('suspended');
      enabled = true;
      sync('已开启轻音效，刷新或退出后恢复静音。');
      play('click');
    } catch { if (version === activation) disable('当前浏览器无法开启音效，页面操作不受影响。'); }
  });
  volumeInput.addEventListener('input', () => {
    volume = Math.max(0, Math.min(30, Number(volumeInput.value) || 0)) / 100;
    sync(!volume ? '音量为 0，当前静音。' : enabled ? '已开启轻音效，刷新或退出后恢复静音。' : '默认静音，仅在本次会话开启。');
  });
  volumeInput.addEventListener('change', () => { play('click'); });
  const target = node => node?.nodeType === 1
    ? node.closest('button,a[href],summary,[role="tab"]') : null;
  const eligible = node => node && !node.closest('#interaction-preferences') &&
    !node.matches(':disabled,[aria-disabled="true"],[aria-busy="true"]');
  const observedDocuments = new WeakSet(), observedFrames = new WeakSet();
  function observe(doc) {
    if (!doc || observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    doc.addEventListener('pointerover', event => {
      clearTimeout(hoverTimer);
      if (!event.isTrusted || event.pointerType !== 'mouse' || !enabled) return;
      const control = target(event.target);
      if (!eligible(control) || control.contains(event.relatedTarget)) return;
      hoverTimer = setTimeout(() => {
        if (control.isConnected && control.matches(':hover') && eligible(control)) play('hover');
      }, 85);
    }, { passive: true });
    doc.addEventListener('pointerout', event => {
      const control = target(event.target);
      if (control && !control.contains(event.relatedTarget)) clearTimeout(hoverTimer);
    }, { passive: true });
    doc.addEventListener('click', event => {
      clearTimeout(hoverTimer);
      if (event.isTrusted && eligible(target(event.target))) play('click');
    }, true);
    if (doc !== document) doc.addEventListener('pointerdown', close);
  }
  function observeFrame(frame) {
    if (observedFrames.has(frame)) return;
    observedFrames.add(frame);
    const connect = () => {
      try { observe(frame.contentDocument); } catch { /* External frames remain silent. */ }
    };
    frame.addEventListener('load', connect);
    connect();
  }
  observe(document);
  document.querySelectorAll('iframe').forEach(observeFrame);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches('iframe')) observeFrame(node);
      node.querySelectorAll('iframe').forEach(observeFrame);
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { clearTimeout(hoverTimer); });
  window.addEventListener('pagehide', () => disable());
  function position() {
    const box = root.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(box.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = Math.min(box.bottom + 8, Math.max(8, innerHeight - panel.offsetHeight - 8)) + 'px';
  }
  function close() { root.open = false; }
  root.addEventListener('toggle', () => {
    root.querySelector('summary').setAttribute('aria-expanded', String(root.open));
    if (root.open) {
      if (panel.showPopover && !panel.matches(':popover-open')) panel.showPopover();
      position();
    } else if (panel.matches(':popover-open')) panel.hidePopover();
  });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && root.open) { close(); root.querySelector('summary').focus(); }
  });
  document.addEventListener('focusin', event => { if (!root.contains(event.target)) close(); });
  window.addEventListener('resize', position);
  window.addEventListener('hashchange', close);
  window.IDInteractionSound = Object.freeze({ play, disable });
  sync();
})();
