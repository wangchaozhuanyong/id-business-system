import { setTimeout as delay } from 'node:timers/promises';

const jobPattern = /^[A-Za-z0-9_-]{1,120}$/;
const scopes = new Set(['task_logs', 'billing_records', 'cdk_codes', 'card_assets',
  'orbitcard_card_usage', 'orbitcard_card_recharges']);

// A sequential consumer acknowledges only after the existing business rules
// have accepted every batch. It never creates, retries or cancels payment jobs.
export async function consumeCommittedJobs(events, { run, pendingJobs, changed, acknowledge,
  signal, wait = milliseconds => delay(milliseconds, undefined, { signal }) }) {
  for await (const event of events) {
    signal?.throwIfAborted();
    if (event?.version !== 1 || typeof event.receipt !== 'string' ||
        !/^[a-f0-9]{64}$/.test(event.receipt) || !Array.isArray(event.jobs) || event.jobs.length > 512 ||
        event.jobs.some(job => typeof job !== 'string' || !jobPattern.test(job)) ||
        !Array.isArray(event.scopes) || event.scopes.some(scope => !scopes.has(scope)) ||
        typeof event.reconcile !== 'boolean') throw new Error('invalid_committed_event');
    const pending = event.reconcile ? await pendingJobs() : [];
    if (!Array.isArray(pending) || pending.some(job => typeof job !== 'string' || !jobPattern.test(job)))
      throw new Error('invalid_pending_jobs');
    const jobs = [...new Set([...event.jobs, ...pending])];
    for (let index = 0; index < jobs.length; index += 6) {
      let failures = 0;
      for (;;) {
        signal?.throwIfAborted();
        try {
          await run({ apply: true, jobKeys: jobs.slice(index, index + 6) });
          break;
        } catch (error) {
          // A 409 means another accepted operation is running, not that this
          // event has been consumed. Other failures leave the source unacked.
          if (error.status !== 409 || failures >= 6) throw new Error('committed_event_not_applied');
          await wait(Math.min(8000, 250 * 2 ** failures++));
        }
      }
    }
    await changed(event.scopes, event);
    signal?.throwIfAborted();
    await acknowledge(event.receipt);
  }
}
