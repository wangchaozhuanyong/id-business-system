import { readFileSync, readdirSync } from 'node:fs';
import { createManualRoutingClient } from '/candidate/modules/recharge/codexdaichong/manual-routing-client.mjs';

const read = path => {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
};
const pid = readdirSync('/proc').find(value => {
  if (!/^[0-9]+$/.test(value)) return false;
  const args = read('/proc/' + value + '/cmdline').split('\0');
  return args.includes('/candidate/modules/recharge/codexdaichong/runtime.mjs') && args.includes('start-production');
});
const field = 'ID_RECHARGE_BRIDGE_SECRET=';
const env = read('/proc/' + pid + '/environ').split('\0');
const secret = env.find(value => value.startsWith(field))?.slice(field.length);
if (!secret || !env.includes('PORT=44575')) process.exit(2);

const actor = { id: 'production-release-manual-options', active: true, role: 'admin' };
const client = createManualRoutingClient({ upstreamUrl: 'http://127.0.0.1:44575', secret });
try {
  const { plans, countries, choices } = await client.options(actor, 'plus');
  const validPlans = Object.keys(plans).length === 4 &&
    ['plus', 'pro100', 'pro200', 'pro500'].every(plan => Object.hasOwn(countries, plans[plan]));
  const validChoices = Array.isArray(choices) && choices.length > 0 && choices.every(row =>
    row.countryCode === plans.plus && row.protocol &&
    Object.keys(row).every(key => ['id', 'name', 'countryCode', 'protocol', 'referenceIp'].includes(key)));
  if (!validPlans || !validChoices) process.exit(2);
  console.log('manual-routing-ready');
} catch { process.exitCode = 2; }
