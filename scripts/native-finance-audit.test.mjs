import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditNativeFinance, runNativeFinance } from './native-finance-audit.mjs';
import {
  FINANCE_ARTIFACT_ROOTS,
  sealFinanceArtifact,
  sha256,
  verifyFinanceArtifact,
  verifyFinanceRunner
} from './native-finance-artifact.mjs';
import * as library from './lib/v2-data-integrity-audit.mjs';

const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../.runtime/native-finance-tests');
const rules = library.V2_DATA_INTEGRITY_CHECKS;
const settings = {
  stage: 'before',
  database: 'id_native_fixture',
  manifestSha256: 'a'.repeat(64),
  rulesSha256: sha256(JSON.stringify(rules))
};

function fixtureClient({
  writeGrant = false,
  failAt = 0,
  wrongDatabase = false,
  count = '0',
  wrongReadOnly = false,
  bigintIdentity = false
} = {}) {
  let queries = 0;
  const calls = [];
  return {
    calls,
    async $connect() {
      calls.push('connect');
    },
    async $disconnect() {
      calls.push('disconnect');
    },
    async $queryRawUnsafe(sql) {
      calls.push(sql);
      assert.equal(sql, 'SHOW GRANTS');
      return [
        {
          grants: `GRANT ${writeGrant ? 'INSERT' : 'SELECT, SHOW VIEW'} ON \`id_native_fixture\`.* TO \`audit\`@\`localhost\``
        }
      ];
    },
    async $executeRawUnsafe(sql) {
      calls.push(sql);
      assert.equal(sql, 'SET SESSION TRANSACTION READ ONLY');
    },
    async $transaction(fn, options) {
      assert.deepEqual(options, { isolationLevel: 'RepeatableRead', timeout: 120000 });
      return fn({
        async $queryRawUnsafe(sql) {
          if (sql.startsWith('SELECT CURRENT_USER'))
            return [
              {
                currentUser: 'audit@localhost',
                databaseName: wrongDatabase ? 'other' : 'id_native_fixture',
                transactionIsolation: 'REPEATABLE-READ',
                sessionReadOnly: wrongReadOnly ? 0 : bigintIdentity ? 1n : 1,
                foreignKeyChecks: bigintIdentity ? 1n : 1
              }
            ];
          queries += 1;
          calls.push(`check:${queries}`);
          if (queries === failAt) throw new Error('database secret suppressed');
          return [{ count }];
        }
      });
    }
  };
}

test('all original 49 checks execute in a verified read-only repeatable-read session', async () => {
  const client = fixtureClient();
  const before = await auditNativeFinance(client, rules, library, settings);
  assert.equal(before.ok, true);
  assert.equal(before.checkCount, 49);
  assert.equal(client.calls.filter((call) => call.startsWith('check:')).length, 49);
  assert.equal(client.calls.at(-1), 'disconnect');
  assert.equal(before.productionCutoverAllowed, false);
  assert.equal(before.historicalClearanceEquivalent, false);
  const after = await auditNativeFinance(fixtureClient(), rules, library, {
    ...settings,
    stage: 'after',
    before
  });
  assert.equal(after.checksSha256, before.checksSha256);
});

test('real MySQL bigint system variables hash identically to validated scalar identity fields', async () => {
  const before = await auditNativeFinance(
    fixtureClient({ bigintIdentity: true }),
    rules,
    library,
    settings
  );
  const after = await auditNativeFinance(fixtureClient(), rules, library, {
    ...settings,
    stage: 'after',
    before
  });
  assert.equal(after.ok, true);
  assert.equal(after.identitySha256, before.identitySha256);
});

test('write grants, wrong target or non-read-only session reject before any rule query', async () => {
  for (const input of [{ writeGrant: true }, { wrongDatabase: true }, { wrongReadOnly: true }]) {
    const client = fixtureClient(input);
    await assert.rejects(auditNativeFinance(client, rules, library, settings));
    assert.equal(client.calls.filter((call) => call.startsWith('check:')).length, 0);
    assert.equal(client.calls.at(-1), 'disconnect');
  }
});

test('unavailable or malformed count cannot produce a green receipt', async () => {
  for (const input of [{ failAt: 17 }, { count: 'invalid' }, { count: '9007199254740992' }]) {
    const client = fixtureClient(input);
    await assert.rejects(auditNativeFinance(client, rules, library, settings));
    assert.equal(client.calls.at(-1), 'disconnect');
  }
  const red = await auditNativeFinance(fixtureClient({ count: '1' }), rules, library, settings);
  assert.equal(red.ok, false);
  assert.equal(red.violationCount, 49);
});

test('changed rule source and after snapshot reject rather than widening the clearance', async () => {
  await assert.rejects(auditNativeFinance(fixtureClient(), rules.slice(0, 48), library, settings));
  const before = await auditNativeFinance(fixtureClient(), rules, library, settings);
  await assert.rejects(
    auditNativeFinance(fixtureClient({ count: '1' }), rules, library, {
      ...settings,
      stage: 'after',
      before
    })
  );
  await assert.rejects(
    auditNativeFinance(fixtureClient(), rules, library, {
      ...settings,
      stage: 'after',
      before: { ...before, manifestSha256: 'b'.repeat(64) }
    })
  );
});

async function withArtifact(fn, { runnerBytes = false } = {}) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(resolve(parent, 'fixture-'));
  const root = resolve(directory, 'artifact');
  mkdirSync(root);
  for (const path of FINANCE_ARTIFACT_ROOTS) {
    const file = resolve(root, path.startsWith('node_modules/') ? `${path}/index.js` : path);
    mkdirSync(dirname(file), { recursive: true });
    let content = path === 'package.json' ? '{"type":"module"}' : '{}';
    if (path === 'scripts/lib/v2-data-integrity-audit.mjs')
      content = `export const V2_DATA_INTEGRITY_CHECKS = ${JSON.stringify(rules)};`;
    if (
      runnerBytes &&
      ['scripts/native-finance-audit.mjs', 'scripts/native-finance-artifact.mjs'].includes(path)
    )
      content = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../', path));
    writeFileSync(file, content);
  }
  const output = resolve(directory, 'manifest.json');
  const run = (_command, args) => ({
    status: 0,
    stdout: args.at(-1) === '--show-toplevel' ? root : 'a'.repeat(40)
  });
  try {
    const receipt = await sealFinanceArtifact({ root, source: root, output }, { run });
    await fn({ directory, root, output, receipt });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('artifact check verifies exact dependency bytes and connects to no database by default', async () => {
  await withArtifact(async ({ root, output, receipt }) => {
    const report = await runNativeFinance(
      { root, manifestPath: output, manifestSha256: receipt.manifestSha256 },
      {}
    );
    assert.equal(report.databaseConnected, false);
    writeFileSync(resolve(root, 'node_modules/.prisma/client/index.js'), 'changed');
    assert.throws(() =>
      verifyFinanceArtifact({ root, manifestPath: output, manifestSha256: receipt.manifestSha256 })
    );
  });
});

test('database execution binds the actual runner bytes to the sealed manifest', async () => {
  await withArtifact(async ({ root, output, receipt }) => {
    await assert.rejects(
      runNativeFinance(
        { root, manifestPath: output, manifestSha256: receipt.manifestSha256, run: true },
        {}
      ),
      (error) => error.auditFailure === 'RUNNER_IDENTITY'
    );
  });
  await withArtifact(
    async ({ root, output, receipt }) => {
      const manifest = verifyFinanceArtifact({
        root,
        manifestPath: output,
        manifestSha256: receipt.manifestSha256
      });
      verifyFinanceRunner(manifest, new URL('./native-finance-audit.mjs', import.meta.url));
      await assert.rejects(
        runNativeFinance(
          { root, manifestPath: output, manifestSha256: receipt.manifestSha256, run: true },
          {}
        ),
        (error) => error.auditFailure !== 'RUNNER_IDENTITY'
      );
    },
    { runnerBytes: true }
  );
});

test('artifact rejects digest changes, path traversal and symlinked dependency roots', async () => {
  await withArtifact(async ({ root, output, receipt }) => {
    assert.throws(() =>
      verifyFinanceArtifact({ root, manifestPath: output, manifestSha256: 'f'.repeat(64) })
    );
    const manifest = JSON.parse(readFileSync(output));
    manifest.files[0].path = '../outside';
    const bytes = JSON.stringify(manifest);
    writeFileSync(output, bytes);
    assert.throws(() =>
      verifyFinanceArtifact({ root, manifestPath: output, manifestSha256: sha256(bytes) })
    );
    rmSync(resolve(root, 'node_modules/.prisma/client'), { recursive: true });
    symlinkSync(
      resolve(root, 'node_modules/@prisma/client'),
      resolve(root, 'node_modules/.prisma/client')
    );
    await assert.rejects(
      sealFinanceArtifact({ root, source: root, output: resolve(dirname(output), 'second.json') })
    );
    assert.ok(receipt.fileCount > 0);
  });
});
