import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import * as unbound from './lib/v2-release-maintenance-policy.mjs';
import {
  V2_DATA_INTEGRITY_CHECKS,
  buildV2DataIntegrityCheckQueries
} from './lib/v2-data-integrity-audit.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(base, '../.runtime/maintenance-policy-tests');
mkdirSync(runtime, { recursive: true });
const rawSource = readFileSync(join(base, 'lib/v2-release-maintenance-policy.mjs'), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fp = unbound.fingerprint;
const CURRENT = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
const DATABASE = 'id_business_v2_partial_cleanup_20261005_v1';
const COST = 'cash_historical_cost_evidence_mismatch';
const CASH = 'finance_cash_source_currency_mismatch';
const TABLES = ['id_business_v2_finance_journals', 'id_business_v2_finance_journal_lines'];
const actualOriginHashes = {
  originManifest: '202262260aca06d9c2d613e9b3ed1e7e6dc9d41d02e6834560e44488dfb33866',
  originBefore: 'b54520e73edffbc0a9fcf6592da3733b04564c5b65ff41f1ed8789ea782804d5',
  originAfter: '818e1980ab01bff0eafaca24863601bca8b02aa0e4bcadf64c3a671bc38edf63'
};
const uuid = (number) => '00000000-0000-0000-0000-' + String(number).padStart(12, '0');
const ids = Array.from({ length: 6 }, (_value, index) => uuid(index + 1) + ':' + uuid(index + 101));
const identity = {
  databaseName: DATABASE,
  currentUser: 'id_business_audit@%',
  transactionIsolation: 'REPEATABLE-READ',
  foreignKeyChecks: 1,
  transactionReadOnly: 1
};
const q = unbound.schemaQueries();
const columns = [
  ...['id', 'metadata', 'journal_type'].map((columnName) => ({ tableName: TABLES[0], columnName })),
  ...['id', 'journal_id', 'amount_cny', 'finance_account_id'].map((columnName) => ({
    tableName: TABLES[1],
    columnName
  }))
];
const schema = {
  tables: q.tables.map((tableName) => ({ tableName, engine: 'InnoDB' })),
  columns,
  indexes: [],
  relations: [],
  database: { characterSet: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' }
};
const facts = new Map(
  ids.map((entity, index) => [
    entity,
    {
      rows: {
        [TABLES[0]]: [
          { id: uuid(index + 1), metadata: '{"fixture":true}', journal_type: 'expense' }
        ],
        [TABLES[1]]: [
          {
            id: uuid(index + 201),
            journal_id: uuid(index + 1),
            amount_cny: '1.0000',
            finance_account_id: null
          }
        ]
      },
      vector: [1, 0, null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  ])
);
const rowHash = (rows) => fp([...rows].sort((a, b) => a.id.localeCompare(b.id, 'en')));
const items = ids.map((entity) => ({
  entitySha256: hash(entity),
  closureSha256: fp(
    Object.fromEntries(TABLES.map((table) => [table, rowHash(facts.get(entity).rows[table])]))
  ),
  predicateSha256: fp(facts.get(entity).vector)
}));
const originGate = (stage) => ({
  accepted: true,
  stage,
  checkCount: 48,
  executedCheckCount: 48,
  unavailableCheckCount: 0,
  violationCount: 10
});
const originChecks = V2_DATA_INTEGRITY_CHECKS.map(({ code }) => ({
  code,
  status: 'EXECUTED',
  count: code === COST ? 6 : code === CASH ? 4 : 0
}));
const originManifest = {
  commit: CURRENT,
  dataAuditBefore: { historicalException: originGate('before') },
  dataAuditAfter: { historicalException: originGate('after') }
};
const proof = {
  proved: true,
  fixedOriginalSixMode: true,
  helperVersion: 5,
  oldTriggerMetadataOracleMode: true,
  oldOriginalSqlCheckCount: 46,
  oldTriggerMetadataOracleCheckCount: 2,
  candidateOriginalSqlCheckCount: 48,
  releaseAllowed: false,
  referenceBound: true,
  oldRootReadOnlyMode: true,
  rootFallbackUsed: false,
  oldFactsReader: 'root',
  newCurrentAuditReader: 'id_business_audit',
  subset: true,
  closureUnchanged: true,
  predicatesUnchanged: true,
  oldCheckCount: 48,
  oldExecutedCheckCount: 48,
  oldUnavailableCheckCount: 0,
  oldViolationCount: 10,
  oldCostCount: 6,
  oldCashCount: 4,
  candidateCheckCount: 48,
  candidateExecutedCheckCount: 48,
  candidateUnavailableCheckCount: 0,
  candidateViolationCount: 6,
  candidateCostCount: 6,
  candidateCashCount: 0,
  rulesSha256: fp(V2_DATA_INTEGRITY_CHECKS),
  schemaSha256: fp(schema),
  oldEntitySetSha256: fp([...ids].sort()),
  candidateEntitySetSha256: fp([...ids].sort()),
  items: items.map((item) => ({ ...item, unchanged: true }))
};
const receiptValues = {
  originManifest,
  originBefore: {
    ok: false,
    checkCount: 48,
    violationCount: 10,
    gate: originGate('before'),
    checks: originChecks
  },
  originAfter: {
    ok: false,
    checkCount: 48,
    violationCount: 10,
    gate: originGate('after'),
    checks: originChecks
  },
  maintenanceSwitch: { fixtureCutover: true },
  maintenanceResume: { fixtureResume: true },
  maintenanceProof: proof
};
const receipts = Object.fromEntries(
  Object.entries(receiptValues).map(([key, value]) => [
    key,
    Buffer.from(JSON.stringify(value) + '\n')
  ])
);
const sourceHashes = {
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py':
    hash('frozen-fixture-worker'),
  'scripts/lib/v2-data-integrity-audit.mjs': hash('frozen-fixture-parser')
};
const policy = {
  version: 1,
  id: 'historical-finance-20261005-maintenance-continuation',
  userApproved: true,
  expectedCurrent: CURRENT,
  databaseName: DATABASE,
  originPolicySha256: '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca',
  rulesSha256: fp(V2_DATA_INTEGRITY_CHECKS),
  schemaSha256: fp(schema),
  candidateEntitySetSha256: fp([...ids].sort()),
  items,
  receiptSha256: Object.fromEntries(Object.entries(receipts).map(([key, raw]) => [key, hash(raw)])),
  candidateSourceSha256: sourceHashes
};
let injected = rawSource
  .replace(
    /const ROOT_SNAPSHOT = [\s\S]*?;\nconst ROOT_SNAPSHOT_SHA256 =\s*'[a-f0-9]+';/,
    'const ROOT_SNAPSHOT = ' +
      JSON.stringify(policy) +
      ';\nconst ROOT_SNAPSHOT_SHA256 = ' +
      JSON.stringify(fp(policy)) +
      ';'
  )
  .replace(
    /export const MAINTENANCE_PROOF_CANONICAL_SHA256 =\s*[\s\S]*?;/,
    'export const MAINTENANCE_PROOF_CANONICAL_SHA256 = ' + JSON.stringify(fp(proof)) + ';'
  )
  .replace(
    "'./v2-data-integrity-audit.mjs'",
    JSON.stringify(pathToFileURL(resolve(base, 'lib/v2-data-integrity-audit.mjs')).href)
  );
for (const [key, origin] of Object.entries(actualOriginHashes))
  injected = injected.replace(origin, policy.receiptSha256[key]);
const gate = await import(
  'data:text/javascript;base64,' + Buffer.from(injected).toString('base64')
);
const checks = V2_DATA_INTEGRITY_CHECKS.map(({ code }) => ({
  code,
  status: 'EXECUTED',
  count: code === COST ? 6 : 0,
  ids: code === COST ? [...ids] : []
}));
const input = () => ({
  policy: structuredClone(policy),
  expectedCurrent: CURRENT,
  sourceHashes: { ...sourceHashes },
  receipts: Object.fromEntries(
    Object.entries(receipts).map(([key, raw]) => [key, Buffer.from(raw)])
  ),
  stage: 'before',
  databaseName: DATABASE,
  identity: { ...identity },
  checks: structuredClone(checks),
  schema: structuredClone(schema),
  facts: structuredClone(facts)
});
const rejected = (value) =>
  assert.throws(() => gate.acceptMaintenanceAudit(value), /^Error: MAINTENANCE_GATE_REJECTED$/);

test('compiled independent policy is fixed to the actual v5 proof and source scope', () => {
  const actual = JSON.parse(
    readFileSync(
      resolve(base, '../deploy/aws/historical-finance-20261005-maintenance-continuation.json'),
      'utf8'
    )
  );
  assert.equal(fp(actual), unbound.MAINTENANCE_POLICY_SHA256);
  assert.deepEqual(
    unbound.validateMaintenancePolicy(actual, CURRENT, actual.candidateSourceSha256),
    actual
  );
  assert.throws(
    () => unbound.validateMaintenancePolicy(policy, CURRENT, sourceHashes),
    /MAINTENANCE_GATE_REJECTED/
  );
  assert.equal(actual.items.length, 6);
  assert.equal(Object.keys(actual.candidateSourceSha256).length, 11);
  assert.equal(unbound.MAINTENANCE_EXPECTED_GATE.violationCount, 6);
});

test('exact6 before/after passes with unchanged full facts and emits only fixed counts and hashes', () => {
  const first = gate.acceptMaintenanceAudit(input());
  assert.equal(first.accepted, true);
  assert.equal(first.violationCount, 6);
  assert.equal(first.executedCheckCount, 48);
  const second = gate.acceptMaintenanceAudit({ ...input(), stage: 'after', before: first });
  assert.deepEqual({ ...first, stage: 'after' }, second);
  const output = JSON.stringify(second);
  for (const id of ids) assert.equal(output.includes(id), false);
  assert.equal(output.includes('1.0000'), false);
  assert.equal(output.includes('fixtureCutover'), false);
});

test('caller cannot broaden or rehash the root-bound policy, source files, current commit or database', () => {
  for (const mutation of [
    (v) => {
      v.policy.id = 'historical-finance-20261005-recharge-diagnostics';
    },
    (v) => {
      v.policy.version = 2;
    },
    (v) => {
      v.policy.userApproved = false;
    },
    (v) => {
      v.policy.unreviewed = true;
    },
    (v) => {
      v.policy.items[0].closureSha256 = hash('changed');
    },
    (v) => {
      v.policy.candidateSourceSha256['package.json'] = hash('new-dependency');
    },
    (v) => {
      v.sourceHashes['package.json'] = hash('new-dependency');
    },
    (v) => {
      v.sourceHashes[Object.keys(v.sourceHashes)[0]] = hash('changed-source');
    },
    (v) => {
      delete v.sourceHashes[Object.keys(v.sourceHashes)[0]];
    },
    (v) => {
      v.expectedCurrent = 'a'.repeat(40);
    },
    (v) => {
      v.databaseName = 'old_database';
    }
  ]) {
    const value = input();
    mutation(value);
    rejected(value);
  }
});

test('all48 rules must execute with the exact cost6 set and every other rule zero', () => {
  for (const mutation of [
    (v) => {
      v.checks.pop();
    },
    (v) => {
      v.checks[0] = structuredClone(v.checks[1]);
    },
    (v) => {
      v.checks[0].count = 1;
      v.checks[0].ids = ['new-exception'];
    },
    (v) => {
      v.checks[0].status = 'SCHEMA_NOT_DEPLOYED';
    },
    (v) => {
      v.checks.find((x) => x.code === COST).count = 5;
      v.checks.find((x) => x.code === COST).ids.pop();
    },
    (v) => {
      v.checks.find((x) => x.code === COST).ids[0] = uuid(999) + ':' + uuid(101);
    },
    (v) => {
      v.checks.find((x) => x.code === COST).ids[0] = v.checks.find((x) => x.code === COST).ids[1];
    },
    (v) => {
      v.checks[0].count = '0';
    },
    (v) => {
      v.checks[0].extra = true;
    }
  ]) {
    const value = input();
    mutation(value);
    rejected(value);
  }
});

test('same IDs cannot conceal changed metadata, amount, all-line membership or NULL predicates', () => {
  for (const mutation of [
    (v) => {
      v.facts.get(ids[0]).rows[TABLES[0]][0].metadata = '{"fixture":false}';
    },
    (v) => {
      v.facts.get(ids[0]).rows[TABLES[1]][0].amount_cny = '2.0000';
    },
    (v) => {
      v.facts
        .get(ids[0])
        .rows[TABLES[1]].push({ ...v.facts.get(ids[0]).rows[TABLES[1]][0], id: uuid(900) });
    },
    (v) => {
      v.facts.get(ids[0]).rows[TABLES[1]][0].finance_account_id = '';
    },
    (v) => {
      v.facts.get(ids[0]).vector[2] = 0;
    },
    (v) => {
      v.facts.get(ids[0]).vector[2] = false;
    },
    (v) => {
      v.facts.get(ids[0]).vector.pop();
    },
    (v) => {
      v.facts.get(ids[0]).vector.fill(0);
    },
    (v) => {
      v.facts.delete(ids[0]);
    },
    (v) => {
      v.facts.set('new', structuredClone(v.facts.get(ids[0])));
    },
    (v) => {
      delete v.facts.get(ids[0]).rows[TABLES[0]][0].metadata;
    },
    (v) => {
      v.facts.get(ids[0]).rows[TABLES[1]][0].journal_id = uuid(900);
    }
  ]) {
    const value = input();
    mutation(value);
    rejected(value);
  }
});

test('schema, read-only principal, isolation and connection identity cannot drift', () => {
  for (const mutation of [
    (v) => {
      v.schema.columns.push({ tableName: TABLES[0], columnName: 'new_column' });
    },
    (v) => {
      v.schema.database.collationName = 'changed';
    },
    (v) => {
      v.identity.currentUser = 'root@%';
    },
    (v) => {
      v.identity.currentUser = 'id_business_audit_fake@%';
    },
    (v) => {
      v.identity.databaseName = 'old_database';
    },
    (v) => {
      v.identity.transactionIsolation = 'READ-COMMITTED';
    },
    (v) => {
      v.identity.foreignKeyChecks = 0;
    },
    (v) => {
      v.identity.transactionReadOnly = 0;
    },
    (v) => {
      v.identity.transactionReadOnly = true;
    },
    (v) => {
      v.identity.private = 'unknown';
    }
  ]) {
    const value = input();
    mutation(value);
    rejected(value);
  }
});

test('all six independent private receipt hashes are required, including maintenance switch/resume', () => {
  for (const key of Object.keys(receipts)) {
    const value = input();
    value.receipts[key] = Buffer.from('{}');
    rejected(value);
  }
  const missing = input();
  delete missing.receipts.maintenanceResume;
  rejected(missing);
  const extra = input();
  extra.receipts.arbitrary = Buffer.from('{}');
  rejected(extra);
});

test('after must match the full accepted before gate; unknown fields and stage confusion reject', () => {
  const first = gate.acceptMaintenanceAudit(input());
  for (const mutation of [
    (v) => {
      v.before.violationCount = 4;
    },
    (v) => {
      v.before.stage = 'after';
    },
    (v) => {
      v.before.sourceSha256 = hash('changed');
    },
    (v) => {
      v.before.receiptSetSha256 = hash('changed');
    },
    (v) => {
      v.before.closureItemsSha256 = hash('changed');
    },
    (v) => {
      v.before.private = true;
    },
    (v) => {
      v.before.accepted = false;
    }
  ]) {
    const value = { ...input(), stage: 'after', before: { ...first } };
    mutation(value);
    rejected(value);
  }
  rejected({ ...input(), stage: 'after' });
  rejected({ ...input(), stage: 'other' });
  rejected({ ...input(), before: first });
});

test('private receipt reader rejects public modes, symlinks and multiply-linked files', () => {
  const root = mkdtempSync(join(runtime, 'maintenance-draft-fixture-'));
  try {
    const paths = Object.fromEntries(
      Object.entries(receipts).map(([key, raw]) => {
        const path = join(root, key + '.json');
        writeFileSync(path, raw, { mode: 0o600 });
        return [key, path];
      })
    );
    const read = gate.readPinnedReceipts(paths);
    assert.deepEqual(read.originManifest, receipts.originManifest);
    chmodSync(paths.maintenanceSwitch, 0o644);
    assert.throws(() => gate.readPinnedReceipts(paths), /MAINTENANCE_GATE_REJECTED/);
    chmodSync(paths.maintenanceSwitch, 0o600);
    const link = join(root, 'link.json');
    symlinkSync(paths.maintenanceSwitch, link);
    assert.throws(
      () => gate.readPinnedReceipts({ ...paths, maintenanceSwitch: link }),
      /MAINTENANCE_GATE_REJECTED/
    );
    unlinkSync(link);
    linkSync(paths.maintenanceSwitch, link);
    assert.throws(() => gate.readPinnedReceipts(paths), /MAINTENANCE_GATE_REJECTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const url =
  'mysql://id_business_audit:fixture-only@mysql/' +
  DATABASE +
  '?connection_limit=1&charset=utf8mb4';
test('audit URL cannot use root, another database, multi-connection pools or unknown options', () => {
  assert.equal(gate.validateAuditUrl(url), url);
  for (const value of [
    url.replace('connection_limit=1', 'connection_limit=2'),
    url.replace('id_business_audit', 'root'),
    url.replace(DATABASE, 'old_database'),
    url.replace('@mysql/', '@external/'),
    url + '&connection_limit=1',
    url + '&sslidentity=/private/file',
    url + '#secret',
    url.replace('?connection_limit=1&charset=utf8mb4', '')
  ]) {
    const error = assert.throws(() => gate.validateAuditUrl(value), /MAINTENANCE_GATE_REJECTED/);
    void error;
  }
});

test('closed facts use only the two full journal tables and the exact 13-condition three-valued SQL', async () => {
  const vector = gate.costVectorQuery();
  assert.equal(vector.predicateCount, 13);
  assert.equal((vector.sql.match(/ELSE NULL END/g) || []).length, 13);
  assert.match(vector.sql, /WHERE BINARY CONCAT/);
  assert.doesNotMatch(vector.sql, /ORDER BY entity_id|\b(?:UPDATE|DELETE|INSERT|GRANT)\b/);
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, param) {
      calls.push([sql, param]);
      for (const table of TABLES)
        if (sql === gate.closureQuery(table, columns))
          return structuredClone(
            facts.get(ids.find((id) => id.startsWith(param + ':'))).rows[table]
          );
      if (sql === vector.sql)
        return [{ id: param, vector: JSON.stringify(facts.get(param).vector) }];
      throw Error('unapproved SQL');
    }
  };
  const collected = await gate.collectClosedFacts(tx, ids, columns);
  assert.deepEqual(collected, facts);
  assert.equal(calls.length, 18);
  for (const table of TABLES) {
    const sql = gate.closureQuery(table, columns);
    for (const column of columns.filter((c) => c.tableName === table))
      assert.ok(sql.includes('CAST(' + String.fromCharCode(96) + column.columnName));
  }
  assert.throws(() => gate.closureQuery('users', columns), /MAINTENANCE_GATE_REJECTED/);
});

function mockClient({
  readOnly = 1,
  wideGrant = false,
  changedSchema = false,
  invalidCount = false
} = {}) {
  const calls = [];
  const before = input();
  const tx = {
    async $queryRawUnsafe(sql, ...parameters) {
      calls.push(sql);
      if (sql.startsWith('SELECT DATABASE() AS databaseName'))
        return [{ ...identity, transactionReadOnly: readOnly }];
      if (sql === q.columns)
        return changedSchema
          ? [...columns, { tableName: TABLES[0], columnName: 'extra' }]
          : columns;
      if (sql === q.tablesSql) return schema.tables;
      if (sql === q.indexes) return schema.indexes;
      if (sql === q.relations) return schema.relations;
      if (sql === q.database) return [schema.database];
      const definition = V2_DATA_INTEGRITY_CHECKS.find(
        (item) => sql === buildV2DataIntegrityCheckQueries(item.sql).count
      );
      if (definition) return [{ count: invalidCount ? null : definition.code === COST ? 6n : 0n }];
      if (sql.startsWith('SELECT entity_id AS id FROM (')) return ids.map((id) => ({ id }));
      for (const table of TABLES)
        if (sql === gate.closureQuery(table, columns))
          return before.facts.get(ids.find((id) => id.startsWith(parameters[0] + ':'))).rows[table];
      if (sql === gate.costVectorQuery().sql)
        return [{ id: parameters[0], vector: before.facts.get(parameters[0]).vector }];
      throw Error('unapproved SQL');
    }
  };
  return {
    calls,
    async $connect() {
      calls.push('connect');
    },
    async $queryRawUnsafe(sql) {
      calls.push(sql);
      assert.equal(sql, 'SHOW GRANTS');
      return [
        {
          Grants: wideGrant
            ? 'GRANT SELECT, UPDATE ON fixture.* TO fixture'
            : 'GRANT SELECT, SHOW VIEW ON fixture.* TO fixture'
        }
      ];
    },
    async $executeRawUnsafe(sql) {
      calls.push(sql);
      assert.equal(sql, 'SET SESSION TRANSACTION READ ONLY');
    },
    async $transaction(callback, options) {
      assert.deepEqual(options, { isolationLevel: 'RepeatableRead', timeout: 120000 });
      calls.push('RR');
      return callback(tx);
    },
    async $disconnect() {
      calls.push('disconnect');
    }
  };
}

test('real maintenance orchestration executes every count and only fixed read-only session/transaction operations', async () => {
  const client = mockClient();
  const result = await gate.runMaintenanceSnapshot(client, { ...input(), connectionUrl: url });
  assert.equal(result.accepted, true);
  assert.equal(
    client.calls.filter((sql) =>
      V2_DATA_INTEGRITY_CHECKS.some(
        (item) => sql === buildV2DataIntegrityCheckQueries(item.sql).count
      )
    ).length,
    48
  );
  assert.equal(client.calls.filter((sql) => sql === 'SET SESSION TRANSACTION READ ONLY').length, 1);
  assert.equal(client.calls.at(-1), 'disconnect');
});

test('writable transactions, broad grants, changed schema or malformed count reject before closure reads', async () => {
  for (const options of [
    { readOnly: 0 },
    { wideGrant: true },
    { changedSchema: true },
    { invalidCount: true }
  ]) {
    const client = mockClient(options);
    await assert.rejects(
      () => gate.runMaintenanceSnapshot(client, { ...input(), connectionUrl: url }),
      /MAINTENANCE_GATE_REJECTED/
    );
    assert.equal(
      client.calls.some((sql) => sql === gate.costVectorQuery().sql),
      false
    );
    assert.equal(client.calls.at(-1), 'disconnect');
  }
});
