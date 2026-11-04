// Bounded, memory-only aggregates. Never record rows, credentials, URLs or query keys.
const samples = new Map<string, number[]>();
const counters = new Map<string, number>();
export function recordV2InteractionSample(kind: 'table-measure' | 'long-task', duration: number) {
  if (!Number.isFinite(duration)) return;
  const values = samples.get(kind) ?? [];
  if (values.length === 120) values.shift();
  values.push(duration);
  samples.set(kind, values);
  try {
    const end = performance.now();
    const name = `v2:${kind}`;
    if ((counters.get(kind) ?? 0) % 120 === 0) performance.clearMeasures(name);
    performance.measure(name, { start: Math.max(0, end - duration), end });
  } catch {
    /* Optional diagnostics cannot affect an interaction. */
  }
  counters.set(kind, (counters.get(kind) ?? 0) + 1);
}
export function recordV2QueryActivity(kind: 'request' | 'deduplicated' | 'cache-hit') {
  counters.set(kind, (counters.get(kind) ?? 0) + 1);
  try {
    const name = `v2:query-${kind}`;
    if ((counters.get(kind) ?? 0) % 120 === 1) performance.clearMarks(name);
    performance.mark(name);
  } catch {
    /* Optional diagnostics cannot affect a query. */
  }
}
export function readV2InteractionDiagnostics() {
  return {
    counts: Object.fromEntries(counters),
    samples: Object.fromEntries([...samples].map(([kind, values]) => [kind, [...values]]))
  };
}
export function observeV2LongTasks() {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')
  )
    return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) recordV2InteractionSample('long-task', entry.duration);
  });
  observer.observe({ type: 'longtask' });
  return () => observer.disconnect();
}
