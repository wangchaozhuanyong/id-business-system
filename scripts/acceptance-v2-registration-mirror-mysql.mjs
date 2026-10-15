import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOwnedMysqlTestOptions,
  startOwnedMysqlTestInstance
} from './lib/owned-mysql-test-instance.mjs';

// Every connection in this script targets its newly owned temporary database.
// Neither a dotenv file nor an inherited DATABASE_URL is used.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const pythonArgs = args.filter((arg) => arg.startsWith('--python='));
assert.ok(pythonArgs.length <= 1, '联合验收只允许一个 Python 路径');
const python = pythonArgs[0]?.slice('--python='.length);
if (python)
  assert.ok(isAbsolute(python) && existsSync(python), '必须显式指定隔离 worker 的 Python');
const options = parseOwnedMysqlTestOptions(args.filter((arg) => !arg.startsWith('--python=')));
const evidence = resolve(root, '.runtime/registration-closed-loop-20261011');
mkdirSync(evidence, { recursive: true });
const report = {
  scope: python ? 'OWNED_EMPTY_SQLITE_AND_MYSQL_ONLY' : 'OWNED_EMPTY_MYSQL_ONLY',
  runtime: options.runtime,
  status: 'NOT_RUN',
  migration: 'NOT_RUN',
  passedChecks: 0,
  syntheticAccounts: null,
  mirrorReceipts: null,
  committedNotifications: 0,
  externalRequests: 0,
  jointClosedLoop: { status: 'NOT_RUN' }
};
const mirrorAction = 'id_business_v2.auto_registration.chatgpt_account.mirror';
let instance;
let prisma;
let workerFixture;
let stage = 'prerequisites';

function migrate(env) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      'prisma-mysql/schema.prisma'
    ],
    {
      cwd: resolve(root, 'apps/api'),
      env,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  // Raw Prisma output can contain connection information and never leaves this process.
  assert.equal(result.status, 0, '自有隔离数据库迁移未通过');
}

function makeInput(index, patch = {}) {
  const value = {
    accountId: randomUUID(),
    sourceTaskUuid: randomUUID(),
    upstreamAccountId: String(index + 1),
    email: `registration-fixture-${index}@example.test`,
    password: randomBytes(24).toString('base64url'),
    registrationCountryCode: 'MY',
    source: 'register',
    ...patch
  };
  const identity = {
    accountId: value.accountId,
    email: value.email.trim().toLowerCase(),
    registrationCountry: value.registrationCountryCode ?? null,
    source: value.source,
    sourceTaskUuid: value.sourceTaskUuid,
    upstreamAccountId: String(value.upstreamAccountId)
  };
  if (value.schemaVersion === 2)
    Object.assign(identity, {
      schemaVersion: 2,
      registrationIp: value.registrationIp ?? null,
      registeredAt: value.registeredAt ?? null,
      creationConfirmed: value.creationConfirmed,
      provider: value.provider,
      identityStatus: value.identityStatus
    });
  return {
    ...value,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(identity, Object.keys(identity).sort()))
      .digest('hex')
  };
}

async function expectConflict(operation) {
  await assert.rejects(operation, (error) => error?.getStatus?.() === 409);
}

function startWorkerFixture(executable) {
  const child = spawn(
    executable,
    ['-B', resolve(root, 'scripts/fixtures/registration-closed-loop-worker.py')],
    {
      cwd: root,
      env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  let buffer = '';
  let pending;
  let exited = false;
  const completion = new Promise((ready) =>
    child.once('close', (code) => {
      exited = true;
      pending?.reject(new Error('合成 SQLite 子进程中断'));
      ready(code);
    })
  );
  // This pipe can contain saved passwords. Consume it only in memory, and
  // never expose raw stdout/stderr, parse errors or payloads to reports.
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) {
      pending?.reject(new Error('合成 SQLite 回执过大'));
      return;
    }
    const boundary = buffer.indexOf('\n');
    if (boundary < 0) return;
    try {
      const response = JSON.parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      if (response.ok !== true) {
        if (Number.isInteger(response.line)) report.sqliteFailureLine = response.line;
        throw new Error('合成 SQLite 场景未通过');
      }
      pending?.resolve(response.result);
    } catch {
      pending?.reject(new Error('合成 SQLite 场景未通过'));
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => pending?.reject(new Error('合成 SQLite 管道已关闭')));
  child.on('error', () => pending?.reject(new Error('合成 SQLite 运行器不可用')));
  return {
    async request(value) {
      assert.equal(exited, false, '合成 SQLite 运行器已退出');
      assert.equal(pending, undefined, '合成 SQLite 请求必须顺序执行');
      let timer;
      try {
        return await new Promise((ready, reject) => {
          pending = { resolve: ready, reject };
          timer = setTimeout(() => reject(new Error('合成 SQLite 回执超时')), 45000);
          child.stdin.write(JSON.stringify(value) + '\n');
        });
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    },
    async close() {
      if (!exited) child.stdin.end(JSON.stringify({ command: 'close' }) + '\n');
      const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
      try {
        assert.equal(await completion, 0, '合成 SQLite 自有夹具清理未正常退出');
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

try {
  const requiredBuilds = [
    'common/prisma/prisma.service.js',
    'common/crypto/field-encryption.service.js',
    'id-business-v2/runtime/id-business-v2-command-transaction.service.js',
    'id-business-v2/runtime/persistence/id-business-v2-transactional-audit.repository.js',
    'id-business-v2/auto-recharge/persistence/bank-recharge.repository.js',
    'id-business-v2/auto-recharge/bank-recharge-account.service.js',
    'id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.js'
  ];
  for (const path of requiredBuilds) assert.ok(existsSync(resolve(root, 'apps/api/dist', path)));
  // Prisma's CLI auto-loads these conventional locations. Refuse to run if any
  // exist so it cannot inspect an operator's saved environment configuration.
  for (const path of ['.env', 'apps/api/.env', 'apps/api/prisma-mysql/.env'])
    assert.equal(existsSync(resolve(root, path)), false, '验收副本不能含自动读取的环境文件');
  stage = 'fixture';
  instance = await startOwnedMysqlTestInstance({
    runtime: options.runtime,
    mysqlBin: options.mysqlBin,
    database: 'id_business_v2_registration_mirror_fixture',
    project: root
  });
  const databaseUrl = `mysql://root:${instance.rootPassword}@127.0.0.1:${instance.port}/${instance.database}`;
  stage = 'migration';
  migrate({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl
  });
  report.migration = 'PASS';

  const require = createRequire(import.meta.url);
  const built = (path) => require(resolve(root, 'apps/api/dist', path));
  const { ConfigService } = require('@nestjs/config');
  const { PrismaService } = built('common/prisma/prisma.service.js');
  const { FieldEncryptionService } = built('common/crypto/field-encryption.service.js');
  const { V2CommandTransactionManager } = built(
    'id-business-v2/runtime/id-business-v2-command-transaction.service.js'
  );
  const { V2TransactionalAuditService } = built(
    'id-business-v2/runtime/persistence/id-business-v2-transactional-audit.repository.js'
  );
  const { BankRechargeRepository } = built(
    'id-business-v2/auto-recharge/persistence/bank-recharge.repository.js'
  );
  const { BankRechargeAccountService } = built(
    'id-business-v2/auto-recharge/bank-recharge-account.service.js'
  );
  const { BankRechargeRegistrationMirrorService } = built(
    'id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.js'
  );
  prisma = new PrismaService({ datasourceUrl: databaseUrl, log: [], errorFormat: 'minimal' });
  await prisma.$connect();
  const encryption = new FieldEncryptionService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      HASH_SECRET: randomBytes(32).toString('hex')
    })
  );
  const audit = new V2TransactionalAuditService();
  const publisher = {
    publishCommittedChangeBestEffort(scopes) {
      assert.deepEqual(scopes, ['auto-recharge']);
      report.committedNotifications += 1;
    }
  };
  const transactions = new V2CommandTransactionManager(prisma, publisher);
  const repository = new BankRechargeRepository(prisma);
  const service = new BankRechargeRegistrationMirrorService(
    repository,
    transactions,
    audit,
    encryption
  );
  const manualAccounts = new BankRechargeAccountService(
    repository,
    transactions,
    audit,
    encryption
  );
  const admins = [0, 1].map((index) => ({
    id: randomUUID(),
    username: `fixture-admin-${index}`,
    displayName: '隔离合成管理员',
    roles: ['admin'],
    permissions: []
  }));
  await prisma.user.createMany({
    data: admins.map(({ id, username, displayName }) => ({
      id,
      username,
      displayName,
      passwordHash: 'synthetic-fixture-login-disabled',
      status: 'disabled'
    }))
  });
  await prisma.idBusinessV2ScopeVersion.upsert({
    where: { scope: 'auto-recharge' },
    create: { scope: 'auto-recharge', version: 1 },
    update: {}
  });
  const getAccount = (id) => prisma.idBusinessV2ChatgptAccount.findUnique({ where: { id } });
  const receipts = (id) =>
    prisma.auditLog.findMany({ where: { action: mirrorAction, ...(id ? { objectId: id } : {}) } });

  stage = 'stable_id_and_encryption';
  const first = makeInput(0);
  const saved = await service.mirrorRegistration(first, admins[0]);
  assert.deepEqual(saved, { accountId: first.accountId, replayed: false });
  const account = await getAccount(first.accountId);
  assert.equal(account.id, first.accountId);
  assert.equal(account.emailHash, encryption.hash(first.email));
  assert.ok(account.emailEncrypted.startsWith('v1:'));
  assert.ok(account.passwordEncrypted.startsWith('v1:'));
  assert.equal(encryption.decrypt(account.emailEncrypted), first.email);
  assert.equal(encryption.decrypt(account.passwordEncrypted), first.password);
  assert.notEqual(account.passwordEncrypted, first.password);
  assert.ok(account.emailMasked.includes('***'));
  assert.notEqual(account.emailMasked, first.email);
  assert.equal(account.registered, true);
  assert.equal(account.offerStatus, 'unknown');
  assert.equal(await prisma.idBusinessV2BankRechargeSubscription.count(), 0);
  const proof = await receipts(first.accountId);
  assert.equal(proof.length, 1);
  assert.equal(proof[0].userId, admins[0].id);
  assert.equal(proof[0].afterData.sourceTaskUuid, first.sourceTaskUuid);
  assert.equal(proof[0].afterData.upstreamAccountId, first.upstreamAccountId);
  assert.equal(proof[0].afterData.fingerprint, first.fingerprint);
  assert.ok(!JSON.stringify(proof).includes(first.password));
  assert.ok(!JSON.stringify(proof).includes(`"${first.email}"`));
  report.passedChecks += 1;

  stage = 'lost_receipt_and_admin_replay';
  // The first return is deliberately treated as lost. A fresh service instance
  // reads only the committed account and same-transaction provenance audit.
  const restarted = new BankRechargeRegistrationMirrorService(
    repository,
    transactions,
    audit,
    encryption
  );
  assert.deepEqual(await restarted.mirrorRegistration(first, admins[1]), {
    accountId: first.accountId,
    replayed: true
  });
  assert.deepEqual(await getAccount(first.accountId), account);
  assert.equal((await receipts(first.accountId)).length, 1);
  report.passedChecks += 1;

  stage = 'concurrent_stable_id';
  const simultaneous = makeInput(1);
  const outputs = await Promise.all(
    Array.from({ length: 4 }, () => service.mirrorRegistration(simultaneous, admins[0]))
  );
  assert.equal(outputs.filter(({ replayed }) => !replayed).length, 1);
  assert.equal(outputs.filter(({ replayed }) => replayed).length, 3);
  assert.equal((await receipts(simultaneous.accountId)).length, 1);
  assert.equal(
    await prisma.idBusinessV2ChatgptAccount.count({
      where: { emailHash: encryption.hash(simultaneous.email) }
    }),
    1
  );
  report.passedChecks += 1;

  stage = 'distinct_bulk_accounts';
  const bulk = Array.from({ length: 30 }, (_, index) => makeInput(index + 10));
  for (const item of bulk)
    assert.equal((await service.mirrorRegistration(item, admins[0])).replayed, false);
  const hashes = await service.registeredEmailHashes(
    bulk.map(({ email }) => email),
    admins[0]
  );
  assert.equal(hashes.size, bulk.length);
  assert.equal(new Set(bulk.map(({ accountId }) => accountId)).size, bulk.length);
  report.passedChecks += 1;

  stage = 'manual_source_conflict';
  const existing = makeInput(100, { registrationCountryCode: 'PH' });
  const manuallySaved = await manualAccounts.createAccount(
    {
      email: existing.email,
      password: existing.password,
      registrationCountryCode: 'PH',
      remark: '合成手工资料'
    },
    admins[0]
  );
  const manualBefore = await getAccount(manuallySaved.id);
  await expectConflict(() => service.mirrorRegistration(existing, admins[1]));
  assert.deepEqual(await getAccount(manuallySaved.id), manualBefore);
  assert.equal((await receipts(manuallySaved.id)).length, 0);
  report.passedChecks += 1;

  stage = 'provenance_conflict';
  const changedSource = makeInput(0, { ...first, sourceTaskUuid: randomUUID() });
  await expectConflict(() => service.mirrorRegistration(changedSource, admins[0]));
  assert.deepEqual(await getAccount(first.accountId), account);
  assert.equal((await receipts(first.accountId)).length, 1);
  report.passedChecks += 1;

  stage = 'soft_delete_protection';
  await prisma.idBusinessV2ChatgptAccount.update({
    where: { id: first.accountId },
    data: { deletedAt: new Date() }
  });
  const deleted = await getAccount(first.accountId);
  await expectConflict(() => service.mirrorRegistration(first, admins[1]));
  assert.deepEqual(await getAccount(first.accountId), deleted);
  assert.ok((await service.registeredEmailHashes([first.email], admins[0])).has(account.emailHash));
  report.passedChecks += 1;

  stage = 'account_audit_atomic_rollback';
  const failed = makeInput(101);
  const beforeNotifications = report.committedNotifications;
  const beforeVersion = await prisma.idBusinessV2ScopeVersion.findUnique({
    where: { scope: 'auto-recharge' }
  });
  const failAfterRealAudit = {
    async append(tx, value) {
      await audit.append(tx, value);
      throw new Error('synthetic-rollback');
    }
  };
  const failingService = new BankRechargeRegistrationMirrorService(
    repository,
    transactions,
    failAfterRealAudit,
    encryption
  );
  await assert.rejects(
    () => failingService.mirrorRegistration(failed, admins[0]),
    /synthetic-rollback/
  );
  assert.equal(await getAccount(failed.accountId), null);
  assert.equal((await receipts(failed.accountId)).length, 0);
  assert.deepEqual(
    await prisma.idBusinessV2ScopeVersion.findUnique({ where: { scope: 'auto-recharge' } }),
    beforeVersion
  );
  assert.equal(report.committedNotifications, beforeNotifications);
  assert.equal((await service.mirrorRegistration(failed, admins[0])).replayed, false);
  report.passedChecks += 1;

  stage = 'existing_login_without_password';
  const login = makeInput(102, {
    source: 'login',
    password: undefined,
    registrationCountryCode: undefined
  });
  await service.mirrorRegistration(login, admins[0]);
  const loginAccount = await getAccount(login.accountId);
  assert.equal(loginAccount.passwordEncrypted, null);
  assert.equal(loginAccount.registrationCountryCode, null);
  assert.equal(loginAccount.offerStatus, 'unknown');
  assert.equal((await service.mirrorRegistration(login, admins[1])).replayed, true);
  assert.equal((await receipts(login.accountId)).length, 1);
  report.passedChecks += 1;

  stage = 'v2_registration_facts_and_authorization_resume';
  const partial = makeInput(103, {
    schemaVersion: 2,
    creationConfirmed: true,
    identityStatus: 'creation_confirmed',
    registrationIp: '203.0.113.8',
    registeredAt: '2026-01-01T01:02:03Z',
    provider: 'apple_hidden'
  });
  await service.mirrorRegistration(partial, admins[0]);
  const created = await getAccount(partial.accountId);
  assert.equal(encryption.decrypt(created.registrationIpEncrypted), partial.registrationIp);
  assert.equal(created.registeredAt.toISOString(), '2026-01-01T01:02:03.000Z');
  assert.ok(created.registrationIpEncrypted.startsWith('v1:'));
  let summary = (await manualAccounts.listAccounts()).items.find(
    (item) => item.id === partial.accountId
  );
  assert.equal(summary.needsSupplement, true);
  const completed = makeInput(103, { ...partial, identityStatus: 'verified' });
  await service.mirrorRegistration(completed, admins[1]);
  assert.deepEqual(await getAccount(partial.accountId), created);
  assert.equal((await receipts(partial.accountId)).length, 2);
  summary = (await manualAccounts.listAccounts()).items.find(
    (item) => item.id === partial.accountId
  );
  assert.equal(summary.needsSupplement, false);
  assert.equal(summary.registrationSource, 'automatic');
  assert.equal(summary.registrationIp, partial.registrationIp);
  await service.mirrorRegistration(completed, admins[1]);
  assert.equal((await receipts(partial.accountId)).length, 2);
  assert.ok(!JSON.stringify(await receipts(partial.accountId)).includes(partial.registrationIp));
  report.passedChecks += 1;

  stage = 'manual_registered_inventory_backfill';
  const manualInput = {
    email: 'manual-registered-fixture@example.test',
    aliasId: 'fixture-alias',
    revision: 3
  };
  assert.equal((await service.previewManualRegistered(manualInput, admins[0])).status, 'create');
  const manualOutputs = await Promise.all(
    Array.from({ length: 3 }, () => service.mirrorManualRegistered(manualInput, admins[0]))
  );
  assert.equal(manualOutputs.filter((item) => !item.replayed).length, 1);
  assert.equal(new Set(manualOutputs.map((item) => item.accountId)).size, 1);
  const manualId = manualOutputs[0].accountId;
  const manualRow = await getAccount(manualId);
  assert.equal(manualRow.registeredAt, null);
  assert.equal(manualRow.passwordEncrypted, null);
  assert.equal(manualRow.registrationIpEncrypted, null);
  assert.equal((await service.previewManualRegistered(manualInput, admins[0])).status, 'exists');
  summary = (await manualAccounts.listAccounts()).items.find((item) => item.id === manualId);
  assert.equal(summary.needsSupplement, true);
  assert.equal(summary.registrationSource, 'manual');
  await prisma.idBusinessV2ChatgptAccount.update({
    where: { id: manualId },
    data: { deletedAt: new Date() }
  });
  assert.equal((await service.previewManualRegistered(manualInput, admins[0])).status, 'deleted');
  await expectConflict(() => service.mirrorManualRegistered(manualInput, admins[0]));
  report.passedChecks += 1;

  if (python) {
    stage = 'joint_sqlite_prepare';
    workerFixture = startWorkerFixture(python);
    const prepared = await workerFixture.request({ command: 'prepare', operatorId: admins[0].id });
    assert.equal(prepared.singleTasks, 1);
    assert.equal(prepared.batchTasks, 2);
    assert.equal(prepared.payloads.length, 3);
    assert.equal(new Set(prepared.payloads.map(({ email }) => email)).size, 3);
    stage = 'joint_mysql_mirror_and_readback';
    const acknowledgements = [];
    for (const payload of prepared.payloads) {
      assert.equal(payload.operatorId, admins[0].id);
      assert.equal(payload.identityStatus, 'verified');
      assert.equal(payload.identityEvidence.emailMatched, true);
      assert.ok(
        ['official_me_response', 'official_session_response'].includes(
          payload.identityEvidence.source
        )
      );
      const input = {
        accountId: payload.accountId,
        sourceTaskUuid: payload.sourceTaskUuid,
        upstreamAccountId: payload.upstreamAccountId,
        email: payload.email,
        password: payload.password || undefined,
        registrationCountryCode: payload.registrationCountry,
        source: payload.source,
        fingerprint: payload.fingerprint,
        ...(payload.schemaVersion === 2
          ? {
              schemaVersion: 2,
              registrationIp: payload.registrationIp,
              registeredAt: payload.registeredAt,
              creationConfirmed: payload.creationConfirmed,
              provider: payload.provider,
              identityStatus: payload.identityStatus
            }
          : {})
      };
      assert.equal(makeInput(0, input).fingerprint, payload.fingerprint);
      assert.deepEqual(await service.mirrorRegistration(input, admins[0]), {
        accountId: payload.accountId,
        replayed: false
      });
      const mainRow = await getAccount(payload.accountId);
      assert.equal(encryption.decrypt(mainRow.emailEncrypted), payload.email);
      assert.equal(encryption.decrypt(mainRow.passwordEncrypted), payload.password);
      assert.equal(mainRow.registrationCountryCode, payload.registrationCountry);
      assert.equal(mainRow.offerStatus, 'unknown');
      const mainProof = await receipts(payload.accountId);
      assert.equal(mainProof.length, 1);
      assert.equal(mainProof[0].afterData.sourceTaskUuid, payload.sourceTaskUuid);
      assert.equal(mainProof[0].afterData.upstreamAccountId, payload.upstreamAccountId);
      assert.equal(mainProof[0].afterData.fingerprint, payload.fingerprint);
      // Deliberately drop the first successful return and replay before ack.
      assert.deepEqual(await restarted.mirrorRegistration(input, admins[1]), {
        accountId: payload.accountId,
        replayed: true
      });
      assert.deepEqual(await getAccount(payload.accountId), mainRow);
      assert.equal((await receipts(payload.accountId)).length, 1);
      acknowledgements.push({
        accountId: payload.accountId,
        sourceTaskUuid: payload.sourceTaskUuid,
        fingerprint: payload.fingerprint
      });
    }
    const listed = await manualAccounts.listAccounts({ page: '1', pageSize: '100' });
    const ids = new Set(acknowledgements.map(({ accountId }) => accountId));
    const listedTargets = listed.items.filter(({ id }) => ids.has(id));
    assert.equal(listedTargets.length, 3);
    for (const item of listedTargets) {
      assert.ok(item.emailMasked.includes('***'));
      assert.equal(item.hasPassword, true);
    }
    const publicList = JSON.stringify(listed);
    for (const payload of prepared.payloads) {
      assert.ok(!publicList.includes(payload.password));
      assert.ok(!publicList.includes(`"${payload.email}"`));
    }
    stage = 'joint_sqlite_ack_and_public_readback';
    const workerReadback = await workerFixture.request({
      command: 'acknowledge',
      accounts: acknowledgements
    });
    assert.equal(workerReadback.sqliteAccounts, 3);
    assert.equal(workerReadback.originalListAccounts, 3);
    assert.equal(workerReadback.publicTasksSaved, 3);
    assert.equal(workerReadback.retryRegistrationCalls, 0);
    assert.equal(workerReadback.retryUploadCalls, 0);
    assert.equal(workerReadback.externalRequests, 0);
    const safeWorkerReadback = {};
    for (const key of [
      'sqliteAccounts',
      'originalListAccounts',
      'publicTasksSaved',
      'batchSaved',
      'singleSaved',
      'pendingSync',
      'distinctEmails',
      'retryRegistrationCalls',
      'retryUploadCalls',
      'blockedSingleRegistrationRetries',
      'skippedBatchRegistrationRetries',
      'flagsPassedOnce',
      'cpaUploads',
      'sub2apiUploads',
      'teamManagerUploads',
      'teamManagerImportAttempts',
      'externalRequests'
    ]) {
      assert.ok(Number.isInteger(workerReadback[key]));
      safeWorkerReadback[key] = workerReadback[key];
    }
    for (const key of [
      'encryptedAtRest',
      'publicCredentialsRedacted',
      'teamManagerImportAvailable'
    ]) {
      assert.equal(typeof workerReadback[key], 'boolean');
      safeWorkerReadback[key] = workerReadback[key];
    }
    report.jointClosedLoop = {
      status: 'PASS',
      ...safeWorkerReadback,
      mysqlAccountListReadback: listedTargets.length,
      mysqlAtomicMirrorReceipts: 3,
      mysqlReceiptLostReplays: 3,
      teamManagerUpload: 'ORIGINAL_FUNCTION_WITH_WORKER_NAME_ADAPTER'
    };
    report.passedChecks += 1;
  }

  stage = 'final_counts';
  report.syntheticAccounts = await prisma.idBusinessV2ChatgptAccount.count();
  report.mirrorReceipts = await prisma.auditLog.count({ where: { action: mirrorAction } });
  assert.equal(report.syntheticAccounts, python ? 40 : 37);
  assert.equal(report.mirrorReceipts, python ? 39 : 36);
  assert.equal(report.passedChecks, python ? 12 : 11);
  report.status = 'PASS';
} catch {
  report.status = 'FAIL';
  report.failedStage = stage;
  process.exitCode = 1;
} finally {
  for (const close of [
    () => prisma?.$disconnect(),
    () => workerFixture?.close(),
    () => instance?.cleanup()
  ]) {
    try {
      await close();
    } catch {
      report.status = 'FAIL';
      report.failedStage = 'owned_cleanup';
      process.exitCode = 1;
    }
  }
  writeFileSync(
    resolve(evidence, 'mirror-mysql-acceptance.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report));
}
