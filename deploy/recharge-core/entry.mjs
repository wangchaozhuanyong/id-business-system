import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyCodexdaichongSource } from '../../modules/recharge/codexdaichong/prepare.mjs';
import { resolveNativeAdminTokenSecret } from '../../modules/recharge/codexdaichong/native-secret.mjs';

const role = process.argv[2];
if (!['native', 'adapter', 'canary-native', 'canary-adapter'].includes(role)) throw new Error('Invalid runtime role');
const canary = role.startsWith('canary-');
const native = role.endsWith('native');
const lines = readFileSync(0, 'utf8').trimEnd().split('\n');
if (lines.length !== (native ? 3 : 4) || lines.slice(0, 2).some((value) => !/^[a-f0-9]{64}$/.test(value)))
  throw new Error('Invalid sealed runtime input');
const env = { ...process.env, DB_PASSWORD: lines[0], ID_RECHARGE_BRIDGE_SECRET: lines[1] };
delete env.NODE_OPTIONS;
const allowed = JSON.parse(readFileSync(new URL('./runtime-settings.json', import.meta.url), 'utf8'));
const options = JSON.parse(lines[2]);
if (!options || Array.isArray(options) || typeof options !== 'object' ||
    Object.entries(options).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string' || value.length > 32768))
  throw new Error('Invalid existing runtime options');
Object.assign(env, options);
env.ADMIN_TOKEN_SECRET = resolveNativeAdminTokenSecret(env);
if (!native) env.ID_RECHARGE_NATIVE_NETWORK_PROOF = lines[3];
if (canary) {
  if (!/^id_redesign_codexdaichong_test_[a-z0-9_]+$/.test(env.DB_NAME || '') || env.DB_USER === 'root')
    throw new Error('Canary requires a separate synthetic database');
  delete env.ID_RECHARGE_RUNTIME_MODE;
} else env.ID_RECHARGE_RUNTIME_MODE = 'production';
await verifyCodexdaichongSource('/candidate/.runtime/codexdaichong');
const runtime = '/candidate/modules/recharge/codexdaichong/runtime.mjs';
const args = native
  ? [...(canary ? [] : ['--import', runtime]), '/candidate/.runtime/codexdaichong/server.js']
  : [runtime, canary ? 'start' : 'start-production'];
const child = spawn(process.execPath, args, { cwd: '/candidate/.runtime/codexdaichong', env, stdio: 'inherit' });
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
try {
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
