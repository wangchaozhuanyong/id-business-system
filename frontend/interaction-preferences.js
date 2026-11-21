/* Opt-in feedback kept across reloads in the current tab. */
(() => {
  'use strict';
  const root = document.getElementById('interaction-preferences');
  if (!root) return;
  const panel = document.getElementById('sound-settings');
  const enabledInput = document.getElementById('sound-enabled');
  const volumeInput = document.getElementById('sound-volume');
  const volumeLabel = document.getElementById('sound-volume-label');
  const label = root.querySelector('[data-sound-label]');
  const status = document.getElementById('sound-state');
  const preferenceKey = 'id-interaction-sound';
  const maxVolume = Number(volumeInput.max);
  const saved = readPreferences();
  let enabled = saved?.enabled === true;
  let volume = Number.isInteger(saved?.volume) && saved.volume >= 0 && saved.volume <= maxVolume
    ? saved.volume : Number(volumeInput.defaultValue);
  let context, activation = 0, activating = false;
  let hoveredControl, hoverTimer, lastHover = -Infinity, lastResult = -Infinity;
  const offMessage = '默认静音。开启后，同一标签页刷新会保留设置。';
  const enabledMessage = '鼠标移入导航或按钮、收到订单保存或代充结果时会播放轻音。';
  const waitingMessage = '音效设置已开启，点击页面或按键后可播放。';
  const mutedMessage = '音量为 0，当前静音。';
  const unavailableMessage = '当前浏览器无法开启音效，页面操作不受影响。';
  const sounds = {
    navigation: { frequency: 540, duration: 0.056, level: 0.26, waveform: 'triangle' },
    hover: { frequency: 480, duration: 0.04, level: 0.18 },
    success: { frequency: 740, duration: 0.075 },
    error: { frequency: 310, duration: 0.065 }
  };
  function readPreferences() {
    try {
      if (document.querySelector('meta[name="id-local-auth"][content="required"]') &&
          !document.querySelector('meta[name="id-local-actor"]')) {
        window.sessionStorage.removeItem(preferenceKey);
        return null;
      }
      return JSON.parse(window.sessionStorage.getItem(preferenceKey));
    } catch { return null; }
  }
  function savePreferences() {
    try { window.sessionStorage.setItem(preferenceKey, JSON.stringify({ enabled, volume })); }
    catch { /* Sound remains usable until the page reloads. */ }
  }
  function sync(message = !volume ? mutedMessage : !enabled ? offMessage
    : context?.state === 'running' ? enabledMessage : waitingMessage) {
    enabledInput.checked = enabled;
    volumeInput.value = String(volume);
    label.textContent = enabled ? '音效开' : '音效关';
    root.dataset.enabled = String(enabled);
    volumeLabel.textContent = volume + '%';
    status.textContent = message;
  }
  function suspendAudio() {
    activation++;
    activating = false;
    clearHover();
    void context?.suspend().catch(() => {});
  }
  function disable(message = '音效已关闭。') {
    enabled = false;
    suspendAudio();
    savePreferences();
    sync(message);
  }
  async function startAudio({ userRequested = false } = {}) {
    if (!enabled || !volume || activating || (!userRequested && context?.state === 'running')) return;
    const version = ++activation;
    activating = true;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('unavailable');
      context ??= new Audio();
      await context.resume();
      if (version !== activation) return;
      if (context.state !== 'running') throw new Error('suspended');
      lastHover = lastResult = -Infinity;
      for (const frame of document.querySelectorAll('iframe')) observeHover(frame.contentDocument);
      sync();
    } catch {
      if (version !== activation) return;
      if (userRequested) disable(unavailableMessage);
      else sync(unavailableMessage);
    } finally {
      if (version === activation) activating = false;
    }
  }
  function unlockAudio(event) {
    if (event.isTrusted && event.target !== enabledInput && navigator.userActivation?.isActive !== false)
      void startAudio();
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
      gain.gain.linearRampToValueAtTime(volume / 100 * level, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
      return true;
    } catch {
      suspendAudio();
      sync(unavailableMessage);
      return false;
    }
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
    doc.addEventListener('click', unlockAudio, true);
    doc.addEventListener('keydown', unlockAudio, true);
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
  enabledInput.addEventListener('change', event => {
    if (!event.isTrusted) return sync();
    if (!enabledInput.checked) return disable();
    enabled = true;
    savePreferences();
    sync();
    void startAudio({ userRequested: true });
  });
  volumeInput.addEventListener('input', event => {
    volume = Math.max(0, Math.min(maxVolume, Number(volumeInput.value) || 0));
    if (!volume) clearHover();
    savePreferences();
    sync();
    unlockAudio(event);
  });
  window.addEventListener('pagehide', suspendAudio);
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
