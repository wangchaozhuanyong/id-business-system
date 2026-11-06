// Ported from the pinned BitBrowser implementation e51dd9c9. See README.md.
import { DirectBrowserError, localBrowserUrl } from './direct-api.mjs';
class BrowserCdp {
  constructor(socket, signal) {
    this.socket = socket;
    this.signal = signal;
    socket.addEventListener('message', (event) => {
      let value;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        this.close();
        return;
      }
      if (typeof value.id === 'number') {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        pending.cleanup();
        if (value.error) pending.reject(new DirectBrowserError('bitbrowser_direct_command_failed'));
        else pending.resolve(value.result ?? {});
      } else if (typeof value.method === 'string') {
        for (const handler of this.handlers)
          handler(value.method, value.params ?? {}, value.sessionId);
      }
    });
    socket.addEventListener('close', () => this.disconnected());
    socket.addEventListener('error', () => this.disconnected());
    signal.addEventListener('abort', () => this.close(), { once: true });
  }
  socket;
  signal;
  sequence = 0;
  pending = new Map();
  handlers = new Set();
  closeHandlers = new Set();
  static connect(endpoint, signal) {
    const url = localBrowserUrl(endpoint, true);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
      const socket = new WebSocket(url);
      const cancel = () => fail('bitbrowser_direct_cancelled');
      const timer = setTimeout(() => fail('bitbrowser_direct_debug_unavailable'), 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      const fail = (reason) => {
        cleanup();
        socket.close();
        reject(new DirectBrowserError(reason));
      };
      signal.addEventListener('abort', cancel, { once: true });
      socket.addEventListener('error', () => fail('bitbrowser_direct_debug_unavailable'), {
        once: true
      });
      socket.addEventListener(
        'open',
        () => {
          cleanup();
          resolve(new BrowserCdp(socket, signal));
        },
        { once: true }
      );
    });
  }
  command(method, params = {}, sessionId, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted || this.socket.readyState !== WebSocket.OPEN)
        return reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
      const id = ++this.sequence;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new DirectBrowserError('bitbrowser_direct_command_failed'));
        },
        Math.max(1, Math.min(30_000, timeoutMs))
      );
      this.pending.set(id, { resolve, reject, cleanup: () => clearTimeout(timer) });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      } catch {
        this.close();
      }
    });
  }
  async evaluate(sessionId, expression, timeoutMs = 15_000) {
    const result = await this.command(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs
    );
    if (result.exceptionDetails) throw new DirectBrowserError('bitbrowser_direct_command_failed');
    return result.result?.value;
  }
  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  disconnected() {
    this.rejectPending();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }
  rejectPending() {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(
        new DirectBrowserError(
          this.signal.aborted
            ? 'bitbrowser_direct_cancelled'
            : 'bitbrowser_direct_debug_unavailable'
        )
      );
    }
    this.pending.clear();
  }
  close() {
    this.rejectPending();
    this.handlers.clear();
    this.disconnected();
    this.socket.close();
  }
}
export { BrowserCdp };
