/** Keep mailbox synchronization outside the event-invalidated list query. */
export function createVendureMailboxRefresh<T extends { key: string }>(options: {
  sync: (scope: T) => Promise<unknown>;
  read: () => Promise<unknown>;
  pending: (value: boolean) => void;
  error: (error: unknown, scope: T) => void;
}) {
  let flight: Promise<void> | null = null;
  let activeKey = '';
  let queued: T | null = null;
  let disposed = false;

  function refresh(scope: T): Promise<void> {
    if (disposed) return Promise.resolve();
    if (flight) {
      queued = scope.key === activeKey ? null : scope;
      return flight;
    }
    activeKey = scope.key;
    options.pending(true);
    const task = Promise.resolve()
      .then(() => {
        if (!disposed) return options.sync(scope);
      })
      .then(async () => {
        if (!disposed) await options.read();
      })
      .catch((error: unknown) => {
        if (!disposed) options.error(error, scope);
      })
      .finally(() => {
        flight = null;
        const next = queued;
        queued = null;
        if (!disposed && next) void refresh(next);
        else if (!disposed) options.pending(false);
      });
    flight = task;
    return task;
  }

  return {
    refresh,
    dispose() {
      disposed = true;
      queued = null;
    }
  };
}
