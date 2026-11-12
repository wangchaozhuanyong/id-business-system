import { readFileSync, readdirSync } from 'node:fs';
import { probeCodexdaichongRuntime } from '../../modules/recharge/codexdaichong/runtime-health.mjs';
import { signRechargeAssertion } from '../../modules/recharge/assertion.mjs';

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const pid = readdirSync('/proc').filter((value) => /^\d+$/.test(value)).find((value) => {
  const args = read('/proc/' + value + '/cmdline').split('\0');
  return args.includes('/candidate/.runtime/codexdaichong/server.js') ||
    args.includes('/candidate/modules/recharge/codexdaichong/runtime.mjs') &&
      (args.includes('start') || args.includes('start-production'));
});
if (!pid) process.exit(1);
const env = Object.fromEntries(read('/proc/' + pid + '/environ').split('\0').filter((value) => value.includes('='))
  .map((value) => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
try {
  const upstreamUrl = 'http://127.0.0.1:' + env.PORT;
  const secret = env.ID_RECHARGE_BRIDGE_SECRET;
  const result = await probeCodexdaichongRuntime({ upstreamUrl, secret });
  if (process.argv.includes('--check-card-plans')) {
    if (!result.ready || env.PORT !== '44575') process.exit(1);
    const actor = { id: 'order-reconciliation', email: 'order-reconciliation@localhost', admin: true, sensitive: true };
    const readRoute = (path, identity = actor) => fetch(upstreamUrl + path, { redirect: 'error',
      signal: AbortSignal.timeout(5000), headers: { 'x-id-recharge-assertion':
        signRechargeAssertion(secret, 'GET', path, identity) } });
    const cardsPath = '/api/admin/cards';
    const denied = await readRoute(cardsPath, { ...actor, admin: false, sensitive: false });
    await denied.body?.cancel();
    const allowed = await readRoute(cardsPath);
    const { success, planPolicy } = allowed.ok ? await allowed.json() : {};
    const retired = await readRoute('/api/admin/gpt-api/config');
    await retired.body?.cancel();
    const ready = denied.status === 403 && success === true && retired.status === 404 &&
      Number.isSafeInteger(planPolicy?.version) && typeof planPolicy.strict === 'boolean';
    console.log(JSON.stringify({ ready, cardPlansReady: ready, retiredProviderRoute: retired.status }));
    if (!ready) process.exitCode = 1;
  } else if (!process.argv.includes('--check-card-stop')) {
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } else {
    if (!result.ready || env.PORT !== '44575') process.exit(1);
    const path = '/api/admin/cards/stop-use';
    const response = await fetch(upstreamUrl + path, { redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', path,
        { id: 'order-reconciliation', email: 'order-reconciliation@localhost', admin: true, sensitive: true }) } });
    await response.body?.cancel();
    const ready = response.status === 405;
    console.log(JSON.stringify({ ready, cardStopRouteReady: ready }));
    if (!ready) process.exitCode = 1;
  }
} catch { process.exitCode = 1; }
