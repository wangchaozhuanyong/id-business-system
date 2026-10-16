import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isProxyResultIdentityOnly,
  proxyResultIdentityBase,
  proxyResultIdentityTree,
  proxyResultIdentityPins,
  proxyResultIdentityPaths,
  proxyResultIdentitySources,
  proxyResultIdentityControls,
  proxyResultIdentityAcceptance,
  proxyResultIdentityEngineTests
} from './ci-proxy-result-identity-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
const paths = [...proxyResultIdentityPaths];
const context = {
  base: proxyResultIdentityBase,
  baseTree: proxyResultIdentityTree,
  sourceDigest: (path) => proxyResultIdentityPins[path]
};
test('exact engine application repair selects real engine checks and its own publisher', () => {
  assert.equal(Object.keys(proxyResultIdentityPins).length, 11);
  assert.equal(isProxyResultIdentityOnly(paths, context), true);
  assert.equal(checkMode(paths, 'same schema', 'same schema', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), ['guards', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(proxyResultIdentityEngineTests.length, 6);
  assert.ok(proxyResultIdentityEngineTests.some((path) => path.endsWith('/regressions.test.cjs')));
  assert.ok(
    proxyResultIdentityEngineTests.some((path) => path.endsWith('/proxy-result-identity.test.cjs'))
  );
});
test('unknown applications, credentials, locks, workflows, SQL and runtime helpers cannot enter the finite channel', () => {
  for (const path of [
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/core.py',
    'apps/admin/src/v2/features/proxy-pool/ProxyPoolEditor.vue',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    '.env',
    'package-lock.json',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/registration-closure-release.py'
  ])
    assert.equal(isProxyResultIdentityOnly([...paths, path], context), false, path);
  assert.equal(isProxyResultIdentityOnly([], context), false);
  assert.equal(isProxyResultIdentityOnly([...paths, paths[0]], context), false);
});
test('every application and publisher digest and the precise baseline are mandatory', () => {
  for (const path of [
    ...proxyResultIdentitySources,
    ...proxyResultIdentityControls,
    proxyResultIdentityAcceptance
  ]) {
    assert.equal(
      isProxyResultIdentityOnly(
        paths.filter((value) => value !== path),
        context
      ),
      false,
      path
    );
    assert.equal(
      isProxyResultIdentityOnly(paths, {
        ...context,
        sourceDigest: (value) => (value === path ? '0'.repeat(64) : context.sourceDigest(value))
      }),
      false,
      path
    );
  }
  for (const change of [
    { base: 'a'.repeat(40) },
    { baseTree: 'b'.repeat(40) },
    {
      sourceDigest: () => {
        throw new Error('missing blob');
      }
    }
  ])
    assert.equal(isProxyResultIdentityOnly(paths, { ...context, ...change }), false);
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  assert.equal(isProxyResultIdentityOnly(proxyResultIdentityControls, context), false);
});

function classifyRealCli({ extra = '', drift = '', base = proxyResultIdentityBase } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Keep this exact historical publication fixture stable when later publishers change.
  // Before its first commit, use the pending source bytes; never transfer blobs in env/argv.
  const fixtureCommit = execFileSync(
    'git',
    [
      'log',
      '--diff-filter=A',
      '-1',
      '--format=%H',
      '--',
      'scripts/ci-proxy-result-identity-scope.mjs'
    ],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const sources = Object.fromEntries(
    Object.keys(proxyResultIdentityPins).map((path) => [
      path,
      fixtureCommit
        ? execFileSync('git', ['show', fixtureCommit + ':' + path], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024
          })
        : readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    ])
  );
  const script = `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { paths, schema, sources, drift, base, baseTree } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const originalRead = fs.readFileSync;
    fs.readFileSync = (path, options) => {
      if (path === 'synthetic-event') return JSON.stringify({ pull_request: {
        number: 900, head: {ref: 'codex/identity-fixture', sha: 'a'.repeat(40)}, base: {sha: base}
      }});
      const value = Object.hasOwn(sources, path)
        ? (typeof options === 'string' ? sources[path] : Buffer.from(sources[path]))
        : originalRead(path, options);
      if (path === drift) return typeof value === 'string' ? value + '\\n' : Buffer.concat([value, Buffer.from('\\n')]);
      return value;
    };
    fs.appendFileSync = () => {};
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') {
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'diff') return paths.join('\\n') + '\\n';
        if (args[0] === 'rev-parse') return args[1] === 'HEAD^{tree}' ? 'c'.repeat(40) + '\\n' : baseTree + '\\n';
        if (args[0] === 'show' && args[1].endsWith(':apps/api/prisma-mysql/schema.prisma')) return schema;
      }
      if (file === 'gh' && args[0] === 'api' && args[1].includes('/workflows/quality.yml/runs?')) return '{"workflow_runs":[]}';
      throw new Error('Unexpected process: ' + file + ' ' + args.join(' '));
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-scope.mjs'];
    await import('./scripts/ci-recharge-scope.mjs');
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      input: JSON.stringify({
        paths: [...paths, ...(extra ? [extra] : [])],
        schema: readFileSync(
          new URL('../apps/api/prisma-mysql/schema.prisma', import.meta.url),
          'utf8'
        ),
        sources,
        drift,
        base,
        baseTree: proxyResultIdentityTree
      }),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'fixture/identity',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: 'synthetic-event',
        GITHUB_REF: 'refs/heads/synthetic',
        GITHUB_OUTPUT: 'synthetic-output',
        GITHUB_STEP_SUMMARY: 'synthetic-summary',
        BASE_SHA: base
      }
    })
  );
}
test('real CLI uses the frozen baseline and actual source bytes, and refuses unknown files or byte drift', () => {
  const positive = classifyRealCli();
  assert.equal(positive.mode, 'recharge');
  assert.deepEqual(positive.checkParts, ['guards', 'online-engine']);
  assert.equal(positive.onlineCiBuild, false);
  assert.equal(classifyRealCli({ extra: 'apps/api/src/auth/auth.service.ts' }).mode, 'full');
  assert.equal(classifyRealCli({ drift: proxyResultIdentitySources[0] }).mode, 'full');
  const wrongBase = classifyRealCli({ base: 'b'.repeat(40) });
  assert.equal(wrongBase.mode, 'full');
  assert.equal(wrongBase.onlineCiBuild, true);
  assert.notDeepEqual(wrongBase.checkParts, ['guards', 'online-engine']);
});
