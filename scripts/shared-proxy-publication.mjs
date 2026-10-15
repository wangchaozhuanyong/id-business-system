import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '04aa234505adccfe295776245b88fc56feac0588';
const output = resolve(root, '.runtime/shared-proxy-release');
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, stdio: 'inherit', ...options });
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const changed = git(['diff', '--name-only', baseline, 'HEAD']).split('\n').filter(Boolean);
function inventory(dir) {
  const result = {};
  function walk(p) {
    for (const file of readdirSync(p, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )) {
      const full = resolve(p, file.name);
      assert.equal(file.isSymbolicLink(), false);
      if (file.isDirectory()) walk(full);
      else if (file.isFile())
        result[relative(dir, full).replaceAll('\\', '/')] = hash(readFileSync(full));
    }
  }
  walk(dir);
  return result;
}
if (process.argv[2] === 'controls') {
  const formatted = changed.filter(
    (path) => existsSync(resolve(root, path)) && /\.(?:[cm]?js|ts|vue|json|md|yml)$/.test(path)
  );
  const linted = formatted.filter((path) => /\.(?:mjs|ts|vue)$/.test(path));
  if (formatted.length) run('npx', ['prettier', '--check', ...formatted]);
  if (linted.length) run('npx', ['eslint', ...linted]);
  run('node', [
    '--test',
    'scripts/ci-shared-proxy-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/production-database-access.test.mjs'
  ]);
} else if (process.argv[2] === 'package') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  mkdirSync(output, { recursive: true });
  const commit = git(['rev-parse', 'HEAD']);
  const source = resolve(root, '.codex-worktrees/shared-proxy-release-baseline');
  assert.equal(existsSync(source), false);
  run('git', ['worktree', 'add', '--detach', source, baseline]);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source });
  run('npm', ['run', 'prisma:mysql:generate'], { cwd: source });
  run('npm', ['run', 'build'], {
    cwd: source,
    env: { ...process.env, V2_BUILD_ID: 'v2-' + baseline }
  });
  const packageDir = resolve(output, 'content');
  mkdirSync(packageDir, { recursive: true });
  const baselineInventory = {
    api: inventory(resolve(source, 'apps/api/dist')),
    admin: inventory(resolve(source, 'apps/admin/dist'))
  };
  writeFileSync(
    resolve(packageDir, 'baseline-inventory.json'),
    JSON.stringify(baselineInventory, null, 2) + '\n'
  );
  const overlays = [];
  for (const path of changed.filter(
    (path) => path.startsWith('apps/api/src/') && path.endsWith('.ts') && !path.endsWith('.spec.ts')
  )) {
    const compiled = path.replace('apps/api/src/', '').replace(/\.ts$/, '.js');
    const file = resolve(root, 'apps/api/dist', compiled);
    assert.ok(existsSync(file), 'Missing compiled source: ' + path);
    const destination = resolve(packageDir, 'api/overlay', compiled);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(file, destination);
    overlays.push(compiled);
    if (existsSync(file + '.map')) cpSync(file + '.map', destination + '.map');
  }
  cpSync(resolve(root, 'apps/admin/dist'), resolve(packageDir, 'admin/dist'), { recursive: true });
  const engineDir = 'apps/api/src/id-business-v2/online-recharge/engine/';
  const engineChanged = changed.filter((path) => path.startsWith(engineDir));
  for (const path of engineChanged) {
    const file = resolve(root, path);
    assert.ok(existsSync(file));
    const destination = resolve(packageDir, 'online-recharge/code', path.slice(engineDir.length));
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(file, destination);
  }
  for (const name of readdirSync(resolve(root, 'node_modules/.prisma/client'))) {
    if (!/\.(?:[cm]?js|json|prisma|d\.ts)$/.test(name)) continue;
    const destination = resolve(packageDir, 'api/prisma-client', name);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(resolve(root, 'node_modules/.prisma/client', name), destination);
  }
  const migration =
    'apps/api/prisma-mysql/migrations/20261015120000_shared_proxy_pool/migration.sql';
  const schemaDir = resolve(packageDir, 'schema');
  mkdirSync(schemaDir, { recursive: true });
  cpSync(resolve(root, migration), resolve(schemaDir, 'migration.sql'));
  cpSync(resolve(root, 'apps/api/prisma-mysql/migrations'), resolve(schemaDir, 'migrations'), {
    recursive: true
  });
  for (const name of [
    'package.json',
    'package-lock.json',
    'apps/api/package.json',
    'apps/admin/package.json',
    'packages/shared/package.json'
  ]) {
    const destination = resolve(packageDir, 'migration/npm', name);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(resolve(root, name), destination);
  }
  cpSync(resolve(root, 'apps/api/prisma-mysql/schema.prisma'), resolve(schemaDir, 'schema.prisma'));
  cpSync(
    resolve(root, 'scripts/lib/v2-production-database-access.mjs'),
    resolve(packageDir, 'production-database-access.mjs')
  );
  const data = {
    status: 'VALIDATED_SCOPED_PUBLICATION_ARTIFACT',
    commit,
    sourceTree: git(['rev-parse', 'HEAD^{tree}']),
    baseline,
    runId: process.env.GITHUB_RUN_ID,
    overlays,
    engineChanged: engineChanged.map((path) => path.slice(engineDir.length)),
    migrationSha256: hash(readFileSync(resolve(root, migration))),
    clientVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/prisma/package.json')))
      .version,
    files: inventory(packageDir),
    businessActions: false
  };
  writeFileSync(resolve(packageDir, 'publication.json'), JSON.stringify(data, null, 2) + '\n');
  run('tar', ['-czf', resolve(output, 'publication.tar.gz'), '-C', packageDir, '.']);
  writeFileSync(
    resolve(output, 'publication-sha256.txt'),
    hash(readFileSync(resolve(output, 'publication.tar.gz'))) + '\n'
  );
  console.log(
    JSON.stringify({
      status: data.status,
      commit,
      baseline,
      overlayCount: overlays.length,
      engineFiles: data.engineChanged
    })
  );
} else throw new Error('Choose controls or package');
