// Run only through a private pipe to systemd-creds encrypt. Never log its output.
import { readFileSync, readdirSync } from 'node:fs';
if (process.argv[2] !== 'sealed-output' || process.stdout.isTTY) throw new Error('Private capture pipe required');
const allowed = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== 'string')) throw new Error('Invalid setting names');
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const pids = readdirSync('/proc').filter((pid) => /^\d+$/.test(pid));
const original = pids.find((pid) => read('/proc/' + pid + '/cmdline').split('\0')
  .some((arg) => arg.endsWith('/.runtime/codexdaichong/server.js')));
if (!original) throw new Error('Original recharge process unavailable');
const parent = pids.find((pid) => {
  const args = read('/proc/' + pid + '/cmdline').split('\0');
  return args.some((arg) => arg.endsWith('/codexdaichong/runtime.mjs')) && args.includes('start-production');
});
const values = {};
for (const pid of [parent, original].filter(Boolean)) {
  for (const item of read('/proc/' + pid + '/environ').split('\0')) {
    const offset = item.indexOf('=');
    const name = item.slice(0, offset);
    if (offset > 0 && allowed.includes(name)) values[name] = item.slice(offset + 1);
  }
}
process.stdout.write(JSON.stringify(values));
