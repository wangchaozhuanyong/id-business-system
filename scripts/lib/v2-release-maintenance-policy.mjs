// Fixed one-use maintenance continuation for the unchanged original six cost facts.
// Public callers cannot supply or expand the independently verified approval scope.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries
} from './v2-data-integrity-audit.mjs';

const ROOT_SNAPSHOT = {
  version: 1,
  id: 'historical-finance-20261005-maintenance-continuation',
  userApproved: true,
  expectedCurrent: '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
  databaseName: 'id_business_v2_partial_cleanup_20261005_v1',
  originPolicySha256: '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca',
  rulesSha256: '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4',
  schemaSha256: '3aef82a77e90f3cb4a2a953d67808193168159aa8983276b67e12f916a0a3655',
  candidateEntitySetSha256: 'f23d021df7a2693b4b5ad3de3818ab6ea475a2362e7c71dd39dc489f3eeb2c43',
  items: [
    {
      entitySha256: '14f8a0d430fbde3b93a4c8dbc3ef26bb09cbe6f118bb85dfdff06ee18bb30ace',
      closureSha256: '7e0245ab613cd5150b0dace5704082922dddb4f9fcc6c51dfc872cf99d40c222',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    },
    {
      entitySha256: '83379e1d32822bb0018c7879835d8e8d8b410e997663d770a06d2b417456d467',
      closureSha256: 'e19eb833b29f7b931a7360312496d1cbe2254c79dcf0b3de3c639fd8163dd138',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    },
    {
      entitySha256: 'ab2b7f90b842d992c28b46905c33ef8fa79dddccc93cdf39b55659af2776797f',
      closureSha256: 'c8ef495334223c9292e75c61fb2e962cd2fbb59b45c04bd1748c6e28301f35da',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    },
    {
      entitySha256: 'bc5f38c1d0c8e4fa7fe32fd567115156e35e47951d7eed372e93cae63052c2cb',
      closureSha256: 'e471f47b54508a809d85e6ac88ea37e8e6c85b96c39863ec8fc91b5dc0869803',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    },
    {
      entitySha256: 'cbfd0101b892cf5cf6f8cf78b45c146d53b6fcb51453c47334c03280518fc3b2',
      closureSha256: '374ea3c52c9c6d195f41c98120a4d4370743c5abea7009ace5fa184ba9668d40',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    },
    {
      entitySha256: 'dcfc8a2ddd64d5bb59dd684fba3c549e6d48e178f4fe1351fd9269a6c066ed25',
      closureSha256: '1a112cd979e13ed3eb849b49c1e86c3b6e9dc3a45ba258763a5c3318d099f0c9',
      predicateSha256: '9bb0daaf6ec949f81ae3da77c94684e9fa30639d295b7f49fb50d40e25c72b20'
    }
  ],
  receiptSha256: {
    originManifest: '202262260aca06d9c2d613e9b3ed1e7e6dc9d41d02e6834560e44488dfb33866',
    originBefore: 'b54520e73edffbc0a9fcf6592da3733b04564c5b65ff41f1ed8789ea782804d5',
    originAfter: '818e1980ab01bff0eafaca24863601bca8b02aa0e4bcadf64c3a671bc38edf63',
    maintenanceSwitch: 'f8394310c8fe2a91a61c77e7bef4b2b196b68f704131a1fe11b116c2687f4634',
    maintenanceResume: '1692deacad7dc074a3fb2e30ef22d7f5b6fec8dd7930644d8d950f0089c21582',
    maintenanceProof: 'd8b9fae9fb2269d8ae601bdcd7aeaf0f978b4865567723fe5d278de95279ca6b'
  },
  candidateSourceSha256: {
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py':
      '9c3c0d7b7d60ae26729486943fb7d4eec15154fb1331646fa755a6a014ebde6a',
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py':
      '1734bacb68549f8dcc28a35426d659069b7aefc8070b110adb5c0bfd70c140a9',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py':
      '2ccb8e3b0e6b3ba9ff2cfc55e1fb96c5352ce6c0767ae7594aab2f5fa30d948f',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py':
      'ac459b9a00eaeb482efc54cc7eecf23fc003c993e6d5991ecf45034c5e1c0696',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py':
      '1327c9fdd8e88807e8ba69bbd288c9b2e62edf015352250e2d54f8d4e9a69173',
    'docs/V2_TASKS.md': '767b8f0a86a4207cea340f7185ad6c0ce1978ad752c226db7d2e89e19e5266e9',
    'scripts/ci-recharge-check.mjs':
      '5b3781d2697ddcb64db3f3149e993b905492652654ff6bd79185d0ae7fc11b5b',
    'scripts/lib/v2-data-integrity-audit.mjs':
      '3764d4701ed90404898ae40765c159bbd058d30090efc3a917ee2bf4e68d8405',
    'scripts/v2-data-integrity-audit.test.mjs':
      'fbaedfc9f65a27c10e569cd846a79ee047021749039472bc722859333ad7db00',
    'scripts/backup-aws-mysql.sh':
      'bd9c4c4c8f5355ef27393027f993f00b34ae115dfb867f3f11ad0b5ca2e3dadd',
    'scripts/aws-mysql-backup.test.mjs':
      'd47e7812b9261e5e7622caa2f7681b67b87b1a06582ac8045706e16d4dcae9e0'
  }
};
const ROOT_SNAPSHOT_SHA256 = '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135';
export const MAINTENANCE_POLICY_ID = 'historical-finance-20261005-maintenance-continuation';
export const MAINTENANCE_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
export const MAINTENANCE_DATABASE = 'id_business_v2_partial_cleanup_20261005_v1';
export const MAINTENANCE_POLICY_SHA256 =
  '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135';
export const MAINTENANCE_RULES_SHA256 =
  '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4';
export const MAINTENANCE_SCHEMA_SHA256 =
  '3aef82a77e90f3cb4a2a953d67808193168159aa8983276b67e12f916a0a3655';
export const MAINTENANCE_ENTITY_SET_SHA256 =
  'f23d021df7a2693b4b5ad3de3818ab6ea475a2362e7c71dd39dc489f3eeb2c43';
export const MAINTENANCE_CLOSURE_ITEMS_SHA256 =
  '0a917c246769c7bcc16d23859e687ed036c97c6289612ea4efc5f7dc16a0ab83';
export const MAINTENANCE_RECEIPT_SET_SHA256 =
  '52839f3b24b7f47897db165a04a22f51d2d5918ad5946cad2f669f53536e831d';
export const MAINTENANCE_SOURCE_SHA256 =
  '526e724a822540c5f33ddd9e38c71e3079efa1fce9672f8ceef5096e38cc7208';
export const MAINTENANCE_PROOF_CANONICAL_SHA256 =
  '94e2ec1ba79c0cb2da503ce49b00260c7f8574ff487bf1f24e5002b7908cf1e3';
export const MAINTENANCE_EXPECTED_GATE = Object.freeze({
  accepted: true,
  status: 'APPROVED_MAINTENANCE_SUBSET',
  policyId: 'historical-finance-20261005-maintenance-continuation',
  expectedCurrent: '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
  fixedCurrent: '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
  checkCount: 48,
  executedCheckCount: 48,
  unavailableCheckCount: 0,
  violationCount: 6,
  databaseName: 'id_business_v2_partial_cleanup_20261005_v1',
  policySha256: '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135',
  rulesSha256: '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4',
  schemaSha256: '3aef82a77e90f3cb4a2a953d67808193168159aa8983276b67e12f916a0a3655',
  entitySetSha256: 'f23d021df7a2693b4b5ad3de3818ab6ea475a2362e7c71dd39dc489f3eeb2c43',
  closureItemsSha256: '0a917c246769c7bcc16d23859e687ed036c97c6289612ea4efc5f7dc16a0ab83',
  receiptSetSha256: '52839f3b24b7f47897db165a04a22f51d2d5918ad5946cad2f669f53536e831d',
  sourceSha256: '526e724a822540c5f33ddd9e38c71e3079efa1fce9672f8ceef5096e38cc7208'
});
const POLICY_ID = MAINTENANCE_POLICY_ID;
const CURRENT = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
const DATABASE = 'id_business_v2_partial_cleanup_20261005_v1';
const ORIGIN_POLICY_SHA256 = '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca';
const RULES_SHA256 = '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4';
const COST_SHA256 = '6bfca3d9ab536eea8c5991e6159ef98de1bfa5b710bef6e45d61dda44d5ce64c';
const COST = 'cash_historical_cost_evidence_mismatch';
const CASH = 'finance_cash_source_currency_mismatch';
const ORIGIN_RAW_SHA256 = Object.freeze({
  originManifest: '202262260aca06d9c2d613e9b3ed1e7e6dc9d41d02e6834560e44488dfb33866',
  originBefore: 'b54520e73edffbc0a9fcf6592da3733b04564c5b65ff41f1ed8789ea782804d5',
  originAfter: '818e1980ab01bff0eafaca24863601bca8b02aa0e4bcadf64c3a671bc38edf63'
});
const RECEIPTS = [
  'originManifest',
  'originBefore',
  'originAfter',
  'maintenanceSwitch',
  'maintenanceResume',
  'maintenanceProof'
];
const TABLES = ['id_business_v2_finance_journals', 'id_business_v2_finance_journal_lines'];
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECEIPT = 8 * 1024 * 1024;
const reject = () => {
  throw new Error('MAINTENANCE_GATE_REJECTED');
};
const requireFact = (condition) => {
  if (!condition) reject();
};
const exactKeys = (value, keys) =>
  requireFact(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function fingerprint(value) {
  const normalize = (item) => {
    if (item instanceof Date) return item.toISOString();
    if (typeof item === 'bigint') return String(item);
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])])
      );
    return item;
  };
  return hash(JSON.stringify(normalize(value)));
}
const rowHash = (rows) =>
  fingerprint([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en')));

function boundSnapshot() {
  if (!ROOT_SNAPSHOT || !ROOT_SNAPSHOT_SHA256) throw new Error('DATA_MISSING');
  requireFact(
    HASH.test(ROOT_SNAPSHOT_SHA256) && fingerprint(ROOT_SNAPSHOT) === ROOT_SNAPSHOT_SHA256
  );
  exactKeys(ROOT_SNAPSHOT, [
    'version',
    'id',
    'userApproved',
    'expectedCurrent',
    'databaseName',
    'originPolicySha256',
    'rulesSha256',
    'schemaSha256',
    'candidateEntitySetSha256',
    'items',
    'receiptSha256',
    'candidateSourceSha256'
  ]);
  requireFact(
    ROOT_SNAPSHOT.version === 1 &&
      ROOT_SNAPSHOT.id === POLICY_ID &&
      ROOT_SNAPSHOT.userApproved === true &&
      ROOT_SNAPSHOT.expectedCurrent === CURRENT &&
      ROOT_SNAPSHOT.databaseName === DATABASE &&
      ROOT_SNAPSHOT.originPolicySha256 === ORIGIN_POLICY_SHA256 &&
      ROOT_SNAPSHOT.rulesSha256 === RULES_SHA256 &&
      HASH.test(ROOT_SNAPSHOT.schemaSha256) &&
      HASH.test(ROOT_SNAPSHOT.candidateEntitySetSha256)
  );
  requireFact(Array.isArray(ROOT_SNAPSHOT.items) && ROOT_SNAPSHOT.items.length === 6);
  const identities = new Set();
  for (const item of ROOT_SNAPSHOT.items) {
    exactKeys(item, ['entitySha256', 'closureSha256', 'predicateSha256']);
    requireFact(
      Object.values(item).every((value) => typeof value === 'string' && HASH.test(value)) &&
        !identities.has(item.entitySha256)
    );
    identities.add(item.entitySha256);
  }
  exactKeys(ROOT_SNAPSHOT.receiptSha256, RECEIPTS);
  requireFact(
    Object.values(ROOT_SNAPSHOT.receiptSha256).every(
      (value) => typeof value === 'string' && HASH.test(value)
    )
  );
  for (const [key, digest] of Object.entries(ORIGIN_RAW_SHA256))
    requireFact(ROOT_SNAPSHOT.receiptSha256[key] === digest);
  const sources = ROOT_SNAPSHOT.candidateSourceSha256;
  requireFact(
    sources &&
      typeof sources === 'object' &&
      !Array.isArray(sources) &&
      Object.keys(sources).length > 0
  );
  for (const [path, digest] of Object.entries(sources))
    requireFact(
      typeof digest === 'string' &&
        HASH.test(digest) &&
        /^(?:apps\/api\/src\/id-business-v2\/auto-recharge\/worker\/(?:registration_browser|test_registration_browser|test_registration_auto_code|plan_selection|test_pro)\.py|docs\/V2_TASKS\.md|scripts\/(?:lib\/v2-data-integrity-audit\.mjs|v2-data-integrity-audit\.test\.mjs|backup-aws-mysql\.sh|aws-mysql-backup\.test\.mjs|ci-recharge-check\.mjs))$/.test(
          path
        )
    );
  requireFact(
    fingerprint(V2_DATA_INTEGRITY_CHECKS) === RULES_SHA256 && V2_DATA_INTEGRITY_CHECKS.length === 48
  );
  return ROOT_SNAPSHOT;
}

export function validateMaintenancePolicy(policy, expectedCurrent, sourceHashes) {
  const bound = boundSnapshot();
  requireFact(
    fingerprint(policy) === ROOT_SNAPSHOT_SHA256 &&
      expectedCurrent === CURRENT &&
      fingerprint(sourceHashes) === fingerprint(bound.candidateSourceSha256)
  );
  return bound;
}

export function readPinnedReceipts(paths) {
  const bound = boundSnapshot();
  exactKeys(paths, RECEIPTS);
  return Object.fromEntries(
    RECEIPTS.map((key) => {
      let descriptor;
      try {
        requireFact(
          typeof paths[key] === 'string' && paths[key].startsWith('/') && !paths[key].includes('\0')
        );
        descriptor = openSync(
          paths[key],
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const before = fstatSync(descriptor);
        requireFact(
          before.isFile() &&
            before.nlink === 1 &&
            [0o400, 0o600].includes(before.mode & 0o7777) &&
            before.size <= MAX_RECEIPT
        );
        const raw = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        requireFact(
          raw.length <= MAX_RECEIPT &&
            before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs &&
            hash(raw) === bound.receiptSha256[key]
        );
        return [key, raw];
      } catch {
        reject();
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    })
  );
}

function validateReceipts(receipts, bound) {
  exactKeys(receipts, RECEIPTS);
  const evidence = {};
  for (const key of RECEIPTS) {
    const raw = receipts[key];
    requireFact(
      raw instanceof Uint8Array &&
        raw.byteLength <= MAX_RECEIPT &&
        hash(raw) === bound.receiptSha256[key]
    );
    try {
      evidence[key] = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      reject();
    }
  }
  requireFact(evidence.originManifest.commit === CURRENT);
  for (const [stage, key] of [
    ['before', 'originBefore'],
    ['after', 'originAfter']
  ]) {
    const report = evidence[key];
    const gate = report.gate;
    requireFact(
      report.ok === false &&
        report.checkCount === 48 &&
        report.violationCount === 10 &&
        gate?.accepted === true &&
        gate.stage === stage &&
        gate.checkCount === 48 &&
        gate.executedCheckCount === 48 &&
        gate.unavailableCheckCount === 0 &&
        gate.violationCount === 10 &&
        Array.isArray(report.checks) &&
        report.checks.length === 48 &&
        fingerprint(report.checks.map((item) => item.code).sort()) ===
          fingerprint(V2_DATA_INTEGRITY_CHECKS.map((item) => item.code).sort())
    );
    for (const check of report.checks)
      requireFact(
        check.status === 'EXECUTED' &&
          check.count === (check.code === COST ? 6 : check.code === CASH ? 4 : 0)
      );
    requireFact(
      fingerprint(
        evidence.originManifest['dataAudit' + stage[0].toUpperCase() + stage.slice(1)]
          .historicalException
      ) === fingerprint(gate)
    );
  }
  const proof = evidence.maintenanceProof;
  requireFact(fingerprint(proof) === MAINTENANCE_PROOF_CANONICAL_SHA256);
  requireFact(
    proof.fixedOriginalSixMode === true &&
      proof.helperVersion === 5 &&
      proof.oldTriggerMetadataOracleMode === true &&
      proof.oldOriginalSqlCheckCount === 46 &&
      proof.oldTriggerMetadataOracleCheckCount === 2 &&
      proof.candidateOriginalSqlCheckCount === 48
  );
  for (const key of [
    'proved',
    'referenceBound',
    'subset',
    'closureUnchanged',
    'predicatesUnchanged'
  ])
    requireFact(proof[key] === true);
  requireFact(
    proof.releaseAllowed === false &&
      proof.oldRootReadOnlyMode === true &&
      proof.rootFallbackUsed === false &&
      proof.oldFactsReader === 'root' &&
      proof.newCurrentAuditReader === 'id_business_audit' &&
      proof.oldCheckCount === 48 &&
      proof.oldExecutedCheckCount === 48 &&
      proof.oldUnavailableCheckCount === 0 &&
      proof.oldViolationCount === 10 &&
      proof.oldCostCount === 6 &&
      proof.oldCashCount === 4 &&
      proof.candidateCheckCount === 48 &&
      proof.candidateExecutedCheckCount === 48 &&
      proof.candidateUnavailableCheckCount === 0 &&
      proof.candidateViolationCount === 6 &&
      proof.candidateCostCount === 6 &&
      proof.candidateCashCount === 0 &&
      proof.rulesSha256 === RULES_SHA256 &&
      proof.schemaSha256 === bound.schemaSha256 &&
      proof.candidateEntitySetSha256 === bound.candidateEntitySetSha256 &&
      proof.oldEntitySetSha256 === bound.candidateEntitySetSha256
  );
  requireFact(Array.isArray(proof.items) && proof.items.length === 6);
  const items = proof.items.map((item) => {
    requireFact(item.unchanged === true);
    return {
      entitySha256: item.entitySha256,
      closureSha256: item.closureSha256,
      predicateSha256: item.predicateSha256
    };
  });
  requireFact(
    fingerprint(items.sort((a, b) => a.entitySha256.localeCompare(b.entitySha256))) ===
      fingerprint([...bound.items].sort((a, b) => a.entitySha256.localeCompare(b.entitySha256)))
  );
  // Switch/resume contents are authenticated by independently frozen raw hashes above.
  return fingerprint(bound.receiptSha256);
}

function requireIdentity(identity, databaseName) {
  exactKeys(identity, [
    'databaseName',
    'currentUser',
    'transactionIsolation',
    'foreignKeyChecks',
    'transactionReadOnly'
  ]);
  requireFact(
    databaseName === DATABASE &&
      identity.databaseName === DATABASE &&
      /^id_business_audit@[^\r\n]+$/.test(identity.currentUser) &&
      identity.transactionIsolation === 'REPEATABLE-READ' &&
      String(identity.foreignKeyChecks) === '1' &&
      String(identity.transactionReadOnly) === '1'
  );
}

function currentCostIds(checks, bound) {
  requireFact(
    Array.isArray(checks) &&
      checks.length === 48 &&
      fingerprint(checks.map((item) => item.code).sort()) ===
        fingerprint(V2_DATA_INTEGRITY_CHECKS.map((item) => item.code).sort())
  );
  for (const check of checks) {
    exactKeys(check, ['code', 'count', 'status', 'ids']);
    requireFact(
      check.status === 'EXECUTED' &&
        Number.isSafeInteger(check.count) &&
        check.count === (check.code === COST ? 6 : 0) &&
        Array.isArray(check.ids) &&
        check.ids.length === check.count &&
        new Set(check.ids).size === check.count &&
        check.ids.every((id) => typeof id === 'string')
    );
  }
  const ids = checks.find((item) => item.code === COST).ids;
  requireFact(fingerprint([...ids].sort()) === bound.candidateEntitySetSha256);
  return ids;
}

function validateSchema(schema, bound) {
  exactKeys(schema, ['tables', 'columns', 'indexes', 'relations', 'database']);
  requireFact(fingerprint(schema) === bound.schemaSha256 && Array.isArray(schema.columns));
  return schema.columns;
}

function closureItems(facts, ids, columns) {
  requireFact(facts instanceof Map && facts.size === 6 && ids.every((id) => facts.has(id)));
  return ids
    .map((entity) => {
      const journalId = entity.split(':')[0];
      requireFact(/^[a-f0-9-]{36}$/.test(journalId));
      const fact = facts.get(entity);
      exactKeys(fact, ['rows', 'vector']);
      exactKeys(fact.rows, TABLES);
      requireFact(
        Array.isArray(fact.vector) &&
          fact.vector.length === 13 &&
          fact.vector.every((item) => item === 0 || item === 1 || item === null) &&
          fact.vector.includes(1)
      );
      for (const table of TABLES) {
        const rows = fact.rows[table];
        const names = columns
          .filter((item) => item.tableName === table)
          .map((item) => item.columnName);
        requireFact(
          names.length > 0 &&
            new Set(names).size === names.length &&
            Array.isArray(rows) &&
            rows.length > 0 &&
            rows.length <= 1000 &&
            new Set(rows.map((row) => row.id)).size === rows.length
        );
        if (table === TABLES[0]) requireFact(rows.length === 1 && rows[0].id === journalId);
        for (const row of rows) {
          exactKeys(row, names);
          requireFact(
            Object.values(row).every((value) => value === null || typeof value === 'string')
          );
          if (table === TABLES[1]) requireFact(row.journal_id === journalId);
        }
      }
      return {
        entitySha256: hash(entity),
        closureSha256: fingerprint(
          Object.fromEntries(TABLES.map((table) => [table, rowHash(fact.rows[table])]))
        ),
        predicateSha256: fingerprint(fact.vector)
      };
    })
    .sort((a, b) => a.entitySha256.localeCompare(b.entitySha256));
}

export function acceptMaintenanceAudit({
  policy,
  expectedCurrent,
  sourceHashes,
  receipts,
  stage,
  databaseName,
  identity,
  checks,
  schema,
  facts,
  before
}) {
  const bound = validateMaintenancePolicy(policy, expectedCurrent, sourceHashes);
  const receiptSetSha256 = validateReceipts(receipts, bound);
  requireFact(stage === 'before' || stage === 'after');
  requireIdentity(identity, databaseName);
  const ids = currentCostIds(checks, bound);
  const columns = validateSchema(schema, bound);
  const items = closureItems(facts, ids, columns);
  requireFact(
    fingerprint(items) ===
      fingerprint([...bound.items].sort((a, b) => a.entitySha256.localeCompare(b.entitySha256)))
  );
  const result = {
    accepted: true,
    status: 'APPROVED_MAINTENANCE_SUBSET',
    policyId: POLICY_ID,
    expectedCurrent: CURRENT,
    fixedCurrent: CURRENT,
    stage,
    checkCount: 48,
    executedCheckCount: 48,
    unavailableCheckCount: 0,
    violationCount: 6,
    databaseName: DATABASE,
    policySha256: ROOT_SNAPSHOT_SHA256,
    rulesSha256: RULES_SHA256,
    schemaSha256: bound.schemaSha256,
    entitySetSha256: bound.candidateEntitySetSha256,
    closureItemsSha256: fingerprint(items),
    receiptSetSha256,
    sourceSha256: fingerprint(sourceHashes)
  };
  if (stage === 'after') {
    requireFact(before && before.stage === 'before');
    requireFact(fingerprint({ ...before, stage: 'after' }) === fingerprint(result));
  } else requireFact(before === undefined || before === null);
  return result;
}

function splitTopLevelOr(expression) {
  const terms = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "'" && expression[index - 1] !== '\\') {
      if (quoted && expression[index + 1] === "'") {
        index++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    requireFact(depth >= 0);
    if (depth === 0 && /^\sOR\s/i.test(expression.slice(index))) {
      terms.push(expression.slice(start, index).trim());
      index += 3;
      start = index;
    }
  }
  requireFact(!quoted && depth === 0);
  terms.push(expression.slice(start).trim());
  requireFact(terms.every(Boolean));
  return terms;
}

export function costVectorQuery() {
  const definition = V2_DATA_INTEGRITY_CHECKS.find((item) => item.code === COST);
  requireFact(fingerprint(definition) === COST_SHA256);
  const sql = definition.sql;
  const projection = sql.indexOf("     SELECT CONCAT(credit.journal_id, ':'");
  const from = sql.indexOf('     FROM credit JOIN ', projection);
  const where = sql.indexOf('\n     WHERE ', from);
  requireFact(projection > 0 && from > projection && where > from);
  const predicates = splitTopLevelOr(sql.slice(where + '\n     WHERE '.length));
  requireFact(predicates.length === 13);
  const entity =
    "CONCAT(credit.journal_id, ':', COALESCE(credit.finance_account_id, 'unassigned'))";
  return {
    predicateCount: 13,
    sql:
      sql.slice(0, projection) +
      'SELECT ' +
      entity +
      ' AS id, JSON_ARRAY(' +
      predicates
        .map(
          (term) => 'CASE WHEN (' + term + ') THEN 1 WHEN NOT (' + term + ') THEN 0 ELSE NULL END'
        )
        .join(', ') +
      ') AS vector\n' +
      sql.slice(from, where) +
      '\nWHERE BINARY ' +
      entity +
      ' = BINARY ?'
  };
}

function identifier(value) {
  requireFact(typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value));
  return String.fromCharCode(96) + value + String.fromCharCode(96);
}
export function closureQuery(table, columns) {
  requireFact(TABLES.includes(table));
  const names = columns
    .filter((column) => column.tableName === table)
    .map((column) => column.columnName);
  requireFact(names.length > 0 && new Set(names).size === names.length);
  return (
    'SELECT ' +
    names
      .map((name) => 'CAST(' + identifier(name) + ' AS CHAR) AS ' + identifier(name))
      .join(', ') +
    ' FROM ' +
    identifier(table) +
    ' WHERE BINARY ' +
    identifier(table === TABLES[1] ? 'journal_id' : 'id') +
    ' = BINARY ? ORDER BY id'
  );
}

export function schemaQueries() {
  const tables = [
    ...new Set(
      V2_DATA_INTEGRITY_CHECKS.flatMap((item) =>
        [
          ...item.sql.matchAll(/\b(?:FROM|JOIN)\s+(id_business_v2_[a-z0-9_]+|users|audit_logs)\b/gi)
        ].map((match) => match[1])
      )
    )
  ].sort();
  const placeholders = tables.map(() => '?').join(',');
  return {
    tables,
    columns:
      'SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, CHARACTER_SET_NAME AS characterSetName, COLLATION_NAME AS collationName, DATETIME_PRECISION AS datetimePrecision FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' +
      placeholders +
      ') ORDER BY TABLE_NAME, ORDINAL_POSITION',
    tablesSql:
      'SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS tableCollation FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' +
      placeholders +
      ') ORDER BY TABLE_NAME',
    indexes:
      'SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequenceInIndex, COLUMN_NAME AS columnName, SUB_PART AS subPart, INDEX_TYPE AS indexType FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' +
      placeholders +
      ') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
    relations:
      'SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName, COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition, REFERENCED_TABLE_NAME AS referencedTableName, REFERENCED_COLUMN_NAME AS referencedColumnName, (REFERENCED_TABLE_SCHEMA IS NULL OR REFERENCED_TABLE_SCHEMA = DATABASE()) AS localReference FROM information_schema.key_column_usage WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' +
      placeholders +
      ') ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION',
    database:
      'SELECT DEFAULT_CHARACTER_SET_NAME AS characterSet, DEFAULT_COLLATION_NAME AS collationName FROM information_schema.schemata WHERE SCHEMA_NAME = DATABASE()'
  };
}

export async function collectClosedFacts(tx, ids, columns) {
  const bound = boundSnapshot();
  requireFact(
    Array.isArray(ids) &&
      ids.length === 6 &&
      new Set(ids).size === 6 &&
      fingerprint([...ids].sort()) === bound.candidateEntitySetSha256
  );
  const vector = costVectorQuery();
  const facts = new Map();
  for (const entity of ids) {
    const journalId = entity.split(':')[0];
    requireFact(/^[a-f0-9-]{36}$/.test(journalId));
    const rows = {};
    for (const table of TABLES)
      rows[table] = await tx.$queryRawUnsafe(closureQuery(table, columns), journalId);
    const values = await tx.$queryRawUnsafe(vector.sql, entity);
    requireFact(values.length === 1 && values[0].id === entity);
    let predicate;
    try {
      predicate =
        typeof values[0].vector === 'string' ? JSON.parse(values[0].vector) : values[0].vector;
    } catch {
      reject();
    }
    facts.set(entity, { rows, vector: predicate });
  }
  closureItems(facts, ids, columns);
  return facts;
}

export function validateAuditUrl(raw) {
  try {
    requireFact(typeof raw === 'string' && Buffer.byteLength(raw) <= 16384 && !/\s/.test(raw));
    const url = new URL(raw);
    requireFact(
      url.protocol === 'mysql:' &&
        url.hostname === 'mysql' &&
        ['', '3306'].includes(url.port) &&
        decodeURIComponent(url.username) === 'id_business_audit' &&
        url.password.length > 0 &&
        decodeURIComponent(url.pathname.slice(1)) === DATABASE &&
        !url.hash
    );
    const options = [...url.searchParams];
    requireFact(new Set(options.map(([key]) => key)).size === options.length);
    requireFact(
      url.searchParams.get('connection_limit') === '1' &&
        options.every(([key, value]) =>
          key === 'charset'
            ? value === 'utf8mb4'
            : ['connection_limit', 'connect_timeout', 'pool_timeout'].includes(key) &&
              /^[1-9][0-9]{0,2}$/.test(value)
        )
    );
    return raw;
  } catch {
    reject();
  }
}

export async function runMaintenanceSnapshot(
  client,
  { policy, expectedCurrent, sourceHashes, receipts, stage, before, connectionUrl }
) {
  const bound = validateMaintenancePolicy(policy, expectedCurrent, sourceHashes);
  validateReceipts(receipts, bound);
  validateAuditUrl(connectionUrl);
  try {
    await client.$connect();
    assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
    await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
    return await client.$transaction(
      async (tx) => {
        const identities = await tx.$queryRawUnsafe(
          'SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, @@transaction_isolation AS transactionIsolation, @@session.foreign_key_checks AS foreignKeyChecks, @@session.transaction_read_only AS transactionReadOnly'
        );
        requireFact(identities.length === 1);
        const identity = identities[0];
        requireIdentity(identity, DATABASE);
        const q = schemaQueries();
        const columns = await tx.$queryRawUnsafe(q.columns, ...q.tables);
        const tables = await tx.$queryRawUnsafe(q.tablesSql, ...q.tables);
        const indexes = await tx.$queryRawUnsafe(q.indexes, ...q.tables);
        const relations = await tx.$queryRawUnsafe(q.relations, ...q.tables);
        const databases = await tx.$queryRawUnsafe(q.database);
        requireFact(
          tables.length === q.tables.length &&
            tables.every((item) => item.engine === 'InnoDB') &&
            relations.every((item) => Number(item.localReference) === 1) &&
            databases.length === 1
        );
        const schema = { tables, columns, indexes, relations, database: databases[0] };
        validateSchema(schema, bound);
        const checks = [];
        for (const definition of V2_DATA_INTEGRITY_CHECKS) {
          const counts = await tx.$queryRawUnsafe(
            buildV2DataIntegrityCheckQueries(definition.sql).count
          );
          requireFact(counts.length === 1);
          exactKeys(counts[0], ['count']);
          const rawCount = counts[0].count;
          requireFact(
            ['number', 'string', 'bigint'].includes(typeof rawCount) &&
              /^[0-9]+$/.test(String(rawCount))
          );
          const count = Number(rawCount);
          requireFact(Number.isSafeInteger(count) && count === (definition.code === COST ? 6 : 0));
          const rows = count
            ? await tx.$queryRawUnsafe(
                'SELECT entity_id AS id FROM (' + definition.sql + ') violations ORDER BY entity_id'
              )
            : [];
          checks.push({
            code: definition.code,
            count,
            status: 'EXECUTED',
            ids: rows.map((row) => String(row.id))
          });
        }
        const ids = currentCostIds(checks, bound);
        const facts = await collectClosedFacts(tx, ids, columns);
        return acceptMaintenanceAudit({
          policy,
          expectedCurrent,
          sourceHashes,
          receipts,
          stage,
          before,
          databaseName: DATABASE,
          identity,
          checks,
          schema,
          facts
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
  } catch {
    reject();
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}
