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
  const sidebar = document.getElementById('sidebar');
  let enabled = false, volume = 0.15, context, lastPlayed = -Infinity, hoverTimer, activation = 0;
  let hoveredNavigation;
  const enabledMessage = '鼠标移入左侧导航时会播放轻音，刷新或退出后恢复静音。';
  const mutedMessage = '音量为 0，当前静音。';
  const sounds = {
    navigation: { frequency: 540, duration: 0.056, level: 0.26, interval: 90, waveform: 'triangle' },
    hover: { frequency: 480, duration: 0.022, level: 0.08, interval: 300 },
    click: { frequency: 580, duration: 0.035 },
    success: { frequency: 740, duration: 0.075 },
    error: { frequency: 310, duration: 0.065 }
  };
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
    hoveredNavigation = undefined;
    void context?.suspend().catch(() => {});
    sync(message);
  }
  function play(kind) {
    const sound = sounds[kind];
    if (!sound || !enabled || !volume || document.hidden || context?.state !== 'running') return false;
    const { frequency, duration, level = 0.18, interval = 65, waveform = 'sine' } = sound;
    const now = performance.now();
    if (now - lastPlayed < interval) return false;
    lastPlayed = now;
    try {
      const oscillator = context.createOscillator(), gain = context.createGain();
      const start = context.currentTime;
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.85, start + duration);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume * level, start + 0.006);
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
      lastPlayed = -Infinity;
      sync(volume ? enabledMessage : mutedMessage);
      play('navigation');
    } catch { if (version === activation) disable('当前浏览器无法开启音效，页面操作不受影响。'); }
  });
  volumeInput.addEventListener('input', () => {
    volume = Math.max(0, Math.min(30, Number(volumeInput.value) || 0)) / 100;
    sync(!volume ? mutedMessage : enabled ? enabledMessage : '默认静音，仅在本次会话开启。');
  });
  volumeInput.addEventListener('change', () => { play('navigation'); });
  const target = node => node?.nodeType === 1
    ? node.closest('button,a[href],summary,[role="tab"]') : null;
  const eligible = node => node && !node.closest('#interaction-preferences') &&
    !node.matches(':disabled,[aria-disabled="true"],[aria-busy="true"]');
  const navigationItem = '.nav-heading, .nav-child';
  // A sidebar rerender can dispatch pointer boundary events under a stationary cursor.
  // Use actual movement and the route or group as the identity for one sound per entry.
  sidebar?.addEventListener('pointermove', event => {
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    const item = target(event.target);
    const next = item?.matches(navigationItem) ? item.dataset.group ?? item.getAttribute('href') : undefined;
    if (next === hoveredNavigation) return;
    hoveredNavigation = next;
    if (next && eligible(item)) play('navigation');
  }, { passive: true });
  sidebar?.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse') hoveredNavigation = undefined;
  }, { passive: true });
  const observedDocuments = new WeakSet(), observedFrames = new WeakSet();
  function observe(doc) {
    if (!doc || observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    doc.addEventListener('pointerover', event => {
      if (!event.isTrusted || event.pointerType !== 'mouse' || !enabled) return;
      const control = target(event.target);
      if (!eligible(control) || control.contains(event.relatedTarget)) return;
      clearTimeout(hoverTimer);
      if (sidebar?.contains(control) && control.matches(navigationItem)) return;
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
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hoverTimer);
    hoveredNavigation = undefined;
  });
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
