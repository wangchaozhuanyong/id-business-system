// Explicit offline gate: no listening server, database, Docker, payment or external requests.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.ID_LAYOUT_QA_OUTPUT || join(root, '.runtime/ui-contract');
const rel = relative(root, output);
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('验收输出必须位于本项目内');
await mkdir(output, { recursive: true });
const frontend = (await readdir(join(root, 'frontend'))).filter(name => name.endsWith('.spec.mjs')).map(name => 'frontend/' + name);
const units = ['local-data-read-cache', 'change-sync-client', 'change-sync-feed', 'contact-write', 'write-operation',
  'module-boundaries', 'document-delta', 'business-lists', 'renewal-sidebar',
  'system-monitoring', 'site-management', 'login-security', 'staff-workspaces', 'renewal-handoff',
  'account-lifecycle', 'account-lifecycle-performance', 'personal-subscriptions', 'inventory-usage', 'operation-recovery',
  'mailbox-updates', 'mailbox-query-content', 'relay-mail-updates', 'recharge-events', 'recharge-activity'];
const browsers = ['search-input', 'ui-idle-contract', 'change-sync', 'performance-read-index', 'system-monitoring', 'site-management',
  'staff-workspaces', 'renewal-handoff', 'shared-layout', 'page-lifecycle', 'order-completion', 'order-submit-stay', 'contact-recovery', 'operation-recovery',
  'mobile-navigation-layout', 'design-list-boundaries', 'global-pagination', 'business-lists', 'site-visual-v2-border',
  'recharge-layout-transitions', 'recharge-server-diagnostic', 'mailbox-updates'];
const groups = [
  ['unit', ['--test', ...frontend, ...units.map(name => `test/${name}.test.mjs`)]],
  ['browser', ['--test', '--test-concurrency=1', ...browsers.map(name => `test/${name}.browser.mjs`)]],
  ['spacing', ['test/site-spacing.browser.mjs']],
  ['mailbox', ['test/mailbox-query-layout.browser.mjs']],
  ['tabs', ['test/tab-layout.browser.mjs']],
  ['feedback', ['--test', '--test-concurrency=1', 'test/action-feedback.browser.mjs', 'test/sidebar-interaction.browser.mjs']]
];
const selected = process.argv.slice(2);
if (selected.some(name => !groups.some(([group]) => group === name))) throw new Error('未知检查组');
const results = selected.length ? await readFile(join(output, 'result.json'), 'utf8')
  .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) : [];
for (const [name, args] of groups.filter(([name]) => !selected.length || selected.includes(name))) {
  const log = join(output, `${name}.log`), started = new Date().toISOString();
  console.log(`检查 ${name}，日志：${log}`);
  const stream = createWriteStream(log);
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
    ID_LAYOUT_QA_OFFLINE: '1', ID_LAYOUT_QA_OUTPUT: join(output, name),
    ID_RECHARGE_QA_PLAYWRIGHT: process.env.ID_RECHARGE_QA_PLAYWRIGHT || join(root, 'node_modules/playwright/index.mjs') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => stream.end(resolve));
  const previous = results.findIndex(result => result.name === name);
  const result = { name, started, code, log };
  if (previous < 0) results.push(result); else results[previous] = result;
  await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(`${name}: ${code === 0 ? '通过' : '失败'}`);
}
process.exitCode = results.some(result => result.code !== 0) || results.length !== groups.length ? 1 : 0;
