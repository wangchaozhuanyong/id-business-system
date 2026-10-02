import { DirectBrowserError, localBrowserUrl } from './bitbrowser-direct-api';

type Document = Record<string, unknown>;
type EventHandler = (method: string, params: Document, sessionId?: string) => void;
export class BrowserCdp {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (result: Document) => void; reject: (reason: Error) => void; cleanup: () => void }
  >();
  private handlers = new Set<EventHandler>();
  private constructor(
    private socket: WebSocket,
    private signal: AbortSignal
  ) {
    socket.addEventListener('message', (event) => {
      let value: Document;
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
        else pending.resolve((value.result ?? {}) as Document);
      } else if (typeof value.method === 'string') {
        for (const handler of this.handlers)
          handler(
            value.method,
            (value.params ?? {}) as Document,
            value.sessionId as string | undefined
          );
      }
    });
    socket.addEventListener('close', () => this.rejectPending());
    socket.addEventListener('error', () => this.rejectPending());
    signal.addEventListener('abort', () => this.close(), { once: true });
  }
  static connect(endpoint: string, signal: AbortSignal): Promise<BrowserCdp> {
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
      const fail = (
        reason: 'bitbrowser_direct_cancelled' | 'bitbrowser_direct_debug_unavailable'
      ) => {
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
  command(method: string, params: Document = {}, sessionId?: string): Promise<Document> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted || this.socket.readyState !== WebSocket.OPEN)
        return reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DirectBrowserError('bitbrowser_direct_command_failed'));
      }, 15_000);
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
  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const result = await this.command(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (result.exceptionDetails) throw new DirectBrowserError('bitbrowser_direct_command_failed');
    return (result.result as Document)?.value as T;
  }
  onEvent(handler: EventHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  private rejectPending() {
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
    this.socket.close();
  }
}
