import { readFileSync, readdirSync } from 'node:fs';
import { probeCodexdaichongRuntime } from '../../modules/recharge/codexdaichong/runtime-health.mjs';

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
  const result = await probeCodexdaichongRuntime({ upstreamUrl: 'http://127.0.0.1:' + env.PORT,
    secret: env.ID_RECHARGE_BRIDGE_SECRET });
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
} catch { process.exitCode = 1; }
