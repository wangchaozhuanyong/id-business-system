/* Transport, theme and draft adapter. Upstream registration algorithms are unchanged. */
(() => {
  const prefix = '/api/id-business-v2/auto-registration/workspace';
  const page = location.pathname.slice(prefix.length) || '/';
  const secretField =
    /password|passwd|pwd|secret|token|cookie|api.?key|(?:^|[-_:])key(?:$|[-_:])|authorization|credential|proxy|cvv|cvc|otp|captcha|verification.?code|security.?code|import|raw.?account|account.?data/i;
  let values = {};
  let draftApplied = false;
  let applying = false;
  let pendingState = null;
  const storage = new Map();

  function emitDraft() {
    if (applying) return;
    parent.postMessage({ type: 'id-registration:draft', page, values }, location.origin);
  }

  function safeField(field) {
    const key = field.id || field.name;
    return (
      key &&
      !secretField.test(key) &&
      !['password', 'hidden', 'file', 'submit', 'button'].includes(field.type) &&
      !field.readOnly &&
      !field.disabled
    );
  }

  function keyOf(field) {
    const key = field.id || field.name;
    return field.type === 'radio' ? `${key}:${field.value}` : key;
  }

  function captureDraft() {
    if (applying) return;
    document.querySelectorAll('input,select,textarea').forEach((field) => {
      if (safeField(field))
        values[keyOf(field)] = ['checkbox', 'radio'].includes(field.type)
          ? field.checked
          : field.value;
    });
    emitDraft();
  }

  // Only non-secret values are delegated to the system's in-memory session draft.
  // No registration data is written to browser storage.
  const memoryStorage = {
    getItem(key) {
      return storage.get(String(key)) ?? null;
    },
    setItem(key, value) {
      key = String(key);
      if (secretField.test(key)) return;
      storage.set(key, String(value));
      values[`storage:${key}`] = String(value);
      emitDraft();
    },
    removeItem(key) {
      storage.delete(String(key));
      delete values[`storage:${key}`];
      emitDraft();
    },
    clear() {
      storage.clear();
      Object.keys(values)
        .filter((key) => key.startsWith('storage:'))
        .forEach((key) => delete values[key]);
      emitDraft();
    },
    key(index) {
      return [...storage.keys()][index] ?? null;
    },
    get length() {
      return storage.size;
    }
  };
  Object.defineProperty(window, 'localStorage', { value: memoryStorage });
  Object.defineProperty(window, 'sessionStorage', { value: memoryStorage });

  function applyState(state) {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.v2Theme = state.theme;
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    storage.set('theme', state.theme);
    for (const [name, value] of Object.entries(state.tokens || {})) {
      if (/^--(?:v2|v3)-[a-z0-9-]+$/.test(name) && typeof value === 'string')
        document.documentElement.style.setProperty(name, value);
    }
    if (draftApplied || document.readyState === 'loading') return;
    draftApplied = true;
    applying = true;
    values = { ...(state.draft || {}) };
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('storage:') && !secretField.test(key))
        storage.set(key.slice(8), String(value));
    }
    document.querySelectorAll('input,select,textarea').forEach((field) => {
      const key = keyOf(field);
      if (!safeField(field) || !(key in values)) return;
      if (['checkbox', 'radio'].includes(field.type)) field.checked = values[key] === true;
      else field.value = String(values[key]);
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    applying = false;
  }

  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      event.data?.type !== 'id-registration:state'
    )
      return;
    if (!['light', 'dark'].includes(event.data.theme)) return;
    pendingState = event.data;
    applyState(event.data);
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/') && !input.startsWith(prefix))
      input = prefix + input;
    return originalFetch(input, init);
  };

  // Original log messages still come from the upstream WebSocket. The browser
  // uses guarded same-origin EventSource, with regular session revalidation.
  class WorkspaceSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.readyState = 0;
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.startsWith(prefix)
        ? parsed.pathname.slice(prefix.length)
        : parsed.pathname;
      if (!/^\/api\/ws\/(task|batch)\/[^/]+$/.test(path)) throw new Error('实时日志地址无效');
      this.path = path;
      this.streamId = crypto.randomUUID();
      this.events = new EventSource(`${prefix}${path}?streamId=${this.streamId}`);
      this.events.addEventListener('connected', () => {
        this.readyState = 1;
        this.onopen?.({});
      });
      this.events.onmessage = (event) => this.onmessage?.({ data: JSON.parse(event.data) });
      this.events.onerror = (event) => {
        this.events.close();
        this.readyState = 3;
        this.onerror?.(event);
        this.onclose?.({ code: 1006 });
      };
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (!['cancel', 'ping'].includes(message.type)) return;
      window
        .fetch(`${prefix}${this.path}?streamId=${this.streamId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: message.type })
        })
        .then((response) => {
          if (!response.ok) throw new Error('实时任务操作失败');
        })
        .catch(() => this.onerror?.({ message: '取消任务失败，请重试' }));
    }
    close() {
      this.events.close();
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  window.WebSocket = WorkspaceSocket;

  window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('input', captureDraft);
    document.addEventListener('change', captureDraft);
    window.addEventListener('pagehide', captureDraft);
    if (pendingState) applyState(pendingState);
    parent.postMessage({ type: 'id-registration:ready', page }, location.origin);
  });
})();
