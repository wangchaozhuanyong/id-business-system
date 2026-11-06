import { BrowserCdp } from './bitbrowser-cdp';

export interface DirectPaymentFrame {
  id: string;
  url: string;
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
}
export interface DirectPaymentSession {
  signal: AbortSignal;
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  frames(): Promise<DirectPaymentFrame[]>;
}
export interface VerifiedPaymentBrowser {
  cdp: BrowserCdp;
  sessionId: string;
  signal: AbortSignal;
  identity: { accountId: string; userId: string; email: string; plan: string };
  profileId: string;
}

/** Scoped to one owned page; child sessions exist only for that page's OOPIFs. */
export async function createDirectPaymentSession(browser: VerifiedPaymentBrowser) {
  const { cdp, sessionId, signal } = browser;
  const children = new Map<string, string>();
  const parents = new Map<string, string>();
  const configuring = new Set<Promise<unknown>>();
  const remove = cdp.onEvent((method, params, parent) => {
    if (parent !== sessionId && ![...children.values()].includes(parent ?? '')) return;
    const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
    if (
      method === 'Target.attachedToTarget' &&
      info?.type === 'iframe' &&
      typeof info.targetId === 'string' &&
      typeof params.sessionId === 'string'
    ) {
      children.set(info.targetId, params.sessionId);
      parents.set(params.sessionId, parent!);
      const child = params.sessionId;
      const setup = Promise.all([
        cdp.command('Page.enable', {}, child),
        cdp.command('Network.enable', {}, child),
        cdp.command(
          'Target.setAutoAttach',
          {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: 'iframe', exclude: false }]
          },
          child
        )
      ]).catch(() => undefined);
      configuring.add(setup);
      void setup.finally(() => configuring.delete(setup));
    }
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      const removed = new Set([params.sessionId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [child, owner] of parents)
          if (removed.has(owner) && !removed.has(child)) {
            removed.add(child);
            grew = true;
          }
      }
      for (const [id, child] of children) if (removed.has(child)) children.delete(id);
      for (const child of removed) parents.delete(child);
    }
  });
  await cdp.command('Page.enable', {}, sessionId);
  await cdp.command(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }]
    },
    sessionId
  );
  const session: DirectPaymentSession = {
    signal,
    evaluate: (expression, timeoutMs) => {
      signal.throwIfAborted();
      return cdp.evaluate(sessionId, expression, timeoutMs);
    },
    async frames() {
      signal.throwIfAborted();
      type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] };
      await Promise.all([...configuring]);
      const result: DirectPaymentFrame[] = [];
      const visited = new Set<string>();
      const visit = async (node: Tree, ownerSession: string) => {
        const { id, url } = node.frame;
        let source: URL;
        try {
          source = new URL(url);
        } catch {
          return;
        }
        if (
          source.protocol === 'https:' &&
          ['chatgpt.com', 'js.stripe.com'].includes(source.hostname) &&
          !source.username &&
          !source.password &&
          !source.port
        ) {
          const childSession = children.get(id);
          const activeSession = childSession ?? ownerSession;
          let contextId: number | undefined;
          if (!childSession) {
            try {
              contextId = Number(
                (
                  await cdp.command(
                    'Page.createIsolatedWorld',
                    {
                      frameId: id,
                      worldName: 'id-business-payment',
                      grantUniveralAccess: false
                    },
                    activeSession
                  )
                ).executionContextId
              );
            } catch {
              /* A newly swapping frame is retried by the form deadline. */
            }
          }
          if ((childSession || contextId) && !visited.has(id)) {
            visited.add(id);
            result.push({
              id,
              url,
              async evaluate<T>(expression: string, timeoutMs = 15_000) {
                signal.throwIfAborted();
                const value = await cdp.command(
                  'Runtime.evaluate',
                  {
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                    ...(contextId ? { contextId } : {})
                  },
                  activeSession,
                  timeoutMs
                );
                if (value.exceptionDetails) throw new Error('付款表单读取未完成，请检查原窗口。');
                return (value.result as { value: T }).value;
              }
            });
          }
        }
        for (const child of node.childFrames ?? [])
          await visit(child, children.get(id) ?? ownerSession);
      };
      for (const source of [sessionId, ...children.values()]) {
        try {
          const tree = (await cdp.command('Page.getFrameTree', {}, source)).frameTree as Tree;
          if (tree?.frame) await visit(tree, source);
        } catch {
          signal.throwIfAborted();
        }
      }
      return result;
    }
  };
  return {
    session,
    ownsSession: (value: string) => value === sessionId || [...children.values()].includes(value),
    close: () => {
      remove();
      children.clear();
      parents.clear();
    }
  };
}

export function waitDirectPayment(signal: AbortSignal, ms = 200) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('本次网页充值已停止。'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
