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
  let enabled = false, volume = 0.15, context, activation = 0;
  let hoveredControl, hoverTimer, lastHover = -Infinity, lastResult = -Infinity;
  const enabledMessage = '鼠标移入导航或按钮、收到订单保存或代充结果时会播放轻音。刷新或退出后恢复静音。';
  const mutedMessage = '音量为 0，当前静音。';
  const sounds = {
    navigation: { frequency: 540, duration: 0.056, level: 0.26, waveform: 'triangle' },
    hover: { frequency: 480, duration: 0.04, level: 0.18 },
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
    clearHover();
    void context?.suspend().catch(() => {});
    sync(message);
  }
  function play(kind) {
    const sound = sounds[kind];
    if (!sound || !enabled || !volume || document.hidden || context?.state !== 'running') return false;
    const { frequency, duration, level = 0.18, waveform = 'sine' } = sound;
    const now = performance.now();
    if (kind === 'hover' || kind === 'navigation') {
      if (now - lastHover < 140 || now - lastResult < 250) return false;
      lastHover = now;
    } else {
      if (now - lastResult < 250) return false;
      lastResult = now;
    }
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
  const controls = 'button, a[href], summary, [role="button"], [role="tab"]';
  function eligible(control) {
    return control && !control.closest('#interaction-preferences, [inert]') &&
      !control.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]');
  }
  function clearHover() {
    clearTimeout(hoverTimer);
    hoveredControl = undefined;
  }
  // Pointer movement avoids sounds from DOM redraws under a stationary mouse.
  function handlePointerMove(event) {
    if (!enabled || !volume || !event.isTrusted || event.pointerType !== 'mouse') return;
    const control = event.target.closest?.(controls);
    if (control === hoveredControl) return;
    clearHover();
    if (!eligible(control)) return;
    hoveredControl = control;
    const sound = control.matches('.nav-heading, .nav-child') ? 'navigation' : 'hover';
    hoverTimer = setTimeout(() => {
      if (control.isConnected && control.matches(':hover') && eligible(control)) play(sound);
    }, 75);
  }
  const observedDocuments = new WeakSet();
  function observeHover(doc) {
    if (!doc || observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    doc.addEventListener('pointermove', handlePointerMove, { passive: true });
    doc.addEventListener('pointerout', event => {
      if (hoveredControl?.ownerDocument === doc && !hoveredControl.contains(event.relatedTarget)) clearHover();
    }, { passive: true });
  }
  observeHover(document);
  document.addEventListener('load', event => {
    if (enabled && event.target instanceof HTMLIFrameElement) observeHover(event.target.contentDocument);
  }, true);
  document.addEventListener('visibilitychange', clearHover);
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
      lastHover = lastResult = -Infinity;
      for (const frame of document.querySelectorAll('iframe')) observeHover(frame.contentDocument);
      sync(volume ? enabledMessage : mutedMessage);
    } catch { if (version === activation) disable('当前浏览器无法开启音效，页面操作不受影响。'); }
  });
  volumeInput.addEventListener('input', () => {
    volume = Math.max(0, Math.min(30, Number(volumeInput.value) || 0)) / 100;
    if (!volume) clearHover();
    sync(!volume ? mutedMessage : enabled ? enabledMessage : '默认静音，仅在本次会话开启。');
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
  window.addEventListener('blur', () => { clearHover(); close(); });
  window.addEventListener('hashchange', close);
  window.IDInteractionSound = Object.freeze({ play, disable });
  sync();
})();
