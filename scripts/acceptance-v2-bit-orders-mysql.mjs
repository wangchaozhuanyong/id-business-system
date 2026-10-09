import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseNativeMysqlTestOptions,
  startNativeMysqlTestInstance
} from './lib/native-mysql-test-instance.mjs';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
assert.equal(process.cwd(), project, '必须从已确认的项目工作树运行');
const options = parseNativeMysqlTestOptions(process.argv.slice(2));
assert.equal(options.runtime, 'native', '仅允许自有原生隔离 MySQL 实例');
const output = resolve(project, '.runtime/bit-orders-20261010/mysql');
mkdirSync(output, { recursive: true, mode: 0o700 });
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { V2_BANK_RECHARGE_PLANS } = require('@apple-business/shared');
const {
  BankRechargePricingService,
  BIT_ORDER_PRICING_SETTINGS_OWNER_ID
} = require('../apps/api/dist/id-business-v2/auto-recharge/bank-recharge-pricing.service.js');
const {
  RechargeSettingsRepository
} = require('../apps/api/dist/id-business-v2/auto-recharge/persistence/recharge-settings.repository.js');
const {
  BankRechargeQueryRepository
} = require('../apps/api/dist/id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.js');
const {
  V2CommandTransactionManager
} = require('../apps/api/dist/id-business-v2/runtime/id-business-v2-command-transaction.service.js');
const {
  V2TransactionalAuditService
} = require('../apps/api/dist/id-business-v2/runtime/persistence/id-business-v2-transactional-audit.repository.js');
const {
  IdBusinessV2FinanceFxService
} = require('../apps/api/dist/id-business-v2/finance/id-business-v2-finance-fx.service.js');
const {
  IdBusinessV2FinanceQueryRepository
} = require('../apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-query.repository.js');
const {
  IdBusinessV2FinanceCommandRepository
} = require('../apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-command.repository.js');

const report = {
  scope: 'OWNED_EMPTY_MYSQL_ONLY',
  schemaChange: 'NONE',
  realPayment: 'NOT_RUN',
  productionAccess: 'NOT_RUN',
  migration: 'NOT_RUN',
  checks: [],
  cleanup: 'NOT_RUN',
  sourceSha256: {}
};
for (const relativePath of [
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-pricing.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-settings.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.ts',
  'scripts/acceptance-v2-bit-orders-mysql.mjs'
]) {
  report.sourceSha256[relativePath] = createHash('sha256')
    .update(readFileSync(resolve(project, relativePath)))
    .digest('hex');
}

function migrateOwnEmptyDatabase(env) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(project, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        'prisma-mysql/schema.prisma'
      ],
      { cwd: resolve(project, 'apps/api'), env, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    child.once('error', () => reject(new Error('ISOLATED_MIGRATION_START_FAILED')));
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error('ISOLATED_MIGRATION_FAILED'));
    });
  });
}

let instance;
let prisma;
let stage = 'START';
try {
  instance = await startNativeMysqlTestInstance({
    mysqlBin: options.mysqlBin,
    database: `id_business_v2_bit_orders_fixture_${process.pid}`,
    project
  });
  const databaseUrl = `mysql://root:${instance.rootPassword}@127.0.0.1:${instance.port}/${instance.database}`;
  const safeEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }
  stage = 'MIGRATION';
  await migrateOwnEmptyDatabase({ ...safeEnv, NODE_ENV: 'test', DATABASE_URL: databaseUrl });
  report.migration = 'EXISTING_MIGRATIONS_APPLIED_TO_EMPTY_TEST_DATABASE';
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  for (const model of [
    prisma.idBusinessV2RechargeBrowserSetting,
    prisma.idBusinessV2BankRechargeOrder,
    prisma.idBusinessV2RechargeJob,
    prisma.auditLog,
    prisma.idBusinessV2FinanceFxRateSnapshot
  ])
    assert.equal(await model.count(), 0, '必须使用新建空的隔离库');
  report.checks.push('全新自有 MySQL 与空目标表');
  const operator = {
    id: randomUUID(),
    username: 'bit-orders-fixture-admin',
    displayName: '隔离验收管理员',
    roles: ['admin'],
    permissions: []
  };
  await prisma.user.create({
    data: {
      id: operator.id,
      username: operator.username,
      passwordHash: 'synthetic-fixture-no-login',
      displayName: operator.displayName
    }
  });
  const transactions = new V2CommandTransactionManager(prisma);
  const audit = new V2TransactionalAuditService();
  const settings = new RechargeSettingsRepository(prisma);
  let providerCalls = 0;
  const blockedProvider = new Proxy(
    {},
    {
      get: () => () => {
        providerCalls += 1;
        throw new Error('LIVE_PROVIDER_FORBIDDEN');
      }
    }
  );
  const fx = new IdBusinessV2FinanceFxService(
    transactions,
    new IdBusinessV2FinanceCommandRepository(),
    new IdBusinessV2FinanceQueryRepository(prisma),
    audit,
    blockedProvider,
    blockedProvider
  );
  const service = new BankRechargePricingService(settings, transactions, audit, fx);
  const failureService = new BankRechargePricingService(
    settings,
    transactions,
    {
      append: async (tx, value) => {
        await audit.append(tx, value);
        throw new Error('SYNTHETIC_AUDIT_ROLLBACK');
      }
    },
    fx
  );
  const planPrices = Object.fromEntries(V2_BANK_RECHARGE_PLANS.map((plan) => [plan, null]));
  const draft = {
    receivedCurrencyCode: 'CNY',
    shoppingFeePercent: '0.01',
    usdtFeePercent: '2.5',
    planPrices: { ...planPrices, go: '500.1234', plus: '1000' },
    updatedAt: null
  };
  const auditCount = () =>
    prisma.auditLog.count({
      where: { action: 'id_business_v2.auto_recharge.order_pricing.settings' }
    });
  const scopeRow = () =>
    prisma.idBusinessV2ScopeVersion.findUnique({ where: { scope: 'auto-recharge' } });
  stage = 'SETTINGS_DEFAULTS';
  assert.deepEqual(await service.read(operator), {
    receivedCurrencyCode: 'CNY',
    shoppingFeePercent: null,
    usdtFeePercent: null,
    planPrices,
    updatedAt: null
  });
  assert.equal(await prisma.idBusinessV2RechargeBrowserSetting.count(), 0);
  report.checks.push('首次人民币默认值与未设置金额，不产生写入');

  stage = 'CREATE_AUDIT_ROLLBACK';
  const beforeCreateScope = await scopeRow();
  await assert.rejects(failureService.update(draft, operator), /SYNTHETIC_AUDIT_ROLLBACK/);
  assert.equal(await settings.findOrderPricing(), null);
  assert.equal(await auditCount(), 0);
  assert.deepEqual(await scopeRow(), beforeCreateScope);
  report.checks.push('首次创建与实际审计同事务回滚');

  stage = 'CONCURRENT_CREATE';
  const concurrentCreate = await Promise.allSettled([
    service.update(draft, operator),
    service.update({ ...draft, shoppingFeePercent: '0.1' }, operator)
  ]);
  assert.equal(concurrentCreate.filter((result) => result.status === 'fulfilled').length, 1);
  const createRejected = concurrentCreate.find((result) => result.status === 'rejected');
  assert.equal(createRejected.reason.getStatus(), 409);
  assert.equal(await auditCount(), 1);
  let saved = await service.read(operator);
  assert.ok(saved.updatedAt);
  assert.equal(saved.planPrices.go, '500.1234');
  await assert.rejects(service.update(draft, operator), (error) => error.getStatus() === 409);
  assert.equal(await auditCount(), 1);
  report.checks.push('并发首次创建只成功一次，重复首次保存不覆盖');

  stage = 'CONCURRENT_UPDATE';
  const concurrentUpdate = await Promise.allSettled([
    service.update({ ...saved, receivedCurrencyCode: 'MYR', shoppingFeePercent: '0.01' }, operator),
    service.update({ ...saved, receivedCurrencyCode: 'PHP', shoppingFeePercent: '0.02' }, operator)
  ]);
  assert.equal(concurrentUpdate.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    concurrentUpdate.find((result) => result.status === 'rejected').reason.getStatus(),
    409
  );
  assert.equal(await auditCount(), 2);
  const stale = saved;
  saved = await service.read(operator);
  assert.ok(new Date(saved.updatedAt).getTime() > new Date(stale.updatedAt).getTime());
  await assert.rejects(service.update(stale, operator), (error) => error.getStatus() === 409);
  assert.equal(await auditCount(), 2);
  assert.deepEqual(await service.read(operator), saved);
  report.checks.push('并发更新、单调版本与旧版本 CAS 拒绝');

  stage = 'UPDATE_AUDIT_ROLLBACK';
  const beforeUpdateScope = await scopeRow();
  await assert.rejects(
    failureService.update({ ...saved, usdtFeePercent: '3.5' }, operator),
    /SYNTHETIC_AUDIT_ROLLBACK/
  );
  assert.deepEqual(await service.read(operator), saved);
  assert.equal(await auditCount(), 2);
  assert.deepEqual(await scopeRow(), beforeUpdateScope);
  report.checks.push('更新与实际审计同事务回滚，范围版本未前进');

  stage = 'SETTINGS_STORAGE_ISOLATION';
  await prisma.idBusinessV2RechargeBrowserSetting.create({
    data: {
      ownerId: operator.id,
      browserOptions: { accountCopySuffix: 'fixture-personal-setting' }
    }
  });
  saved = await service.update(
    {
      ...saved,
      shoppingFeePercent: '0.0100',
      usdtFeePercent: '0',
      planPrices: { ...planPrices, go: '0', plus: null }
    },
    operator
  );
  assert.equal(saved.shoppingFeePercent, '0.01');
  assert.equal(saved.usdtFeePercent, '0');
  assert.equal(saved.planPrices.go, '0');
  assert.equal(saved.planPrices.plus, null);
  assert.deepEqual(
    (
      await prisma.idBusinessV2RechargeBrowserSetting.findUnique({
        where: { ownerId: operator.id },
        select: { browserOptions: true }
      })
    ).browserOptions,
    { accountCopySuffix: 'fixture-personal-setting' }
  );
  const pricingStorage = await prisma.idBusinessV2RechargeBrowserSetting.findUnique({
    where: { ownerId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID },
    select: {
      localApiTokenEncrypted: true,
      connectorTokenEncrypted: true,
      dynamicProxyUrlEncrypted: true,
      staticProxyCredentialsEncrypted: true
    }
  });
  assert.ok(Object.values(pricingStorage).every((value) => value === null));
  report.checks.push('专有共享行不覆盖个人配置或写入秘密字段，精确小数与零/未设置有区别');

  stage = 'READ_ONLY_FX_CACHE';
  const capturedAt = new Date();
  await prisma.idBusinessV2FinanceFxRateSnapshot.createMany({
    data: [
      {
        id: randomUUID(),
        currency: 'PHP',
        rateToCny: '0.12345678',
        source: 'manual',
        businessDate: capturedAt,
        capturedAt,
        expiresAt: new Date(capturedAt.getTime() + 60000),
        sourceEvidence: { private_debug: 'fixture-cache-private' }
      },
      {
        id: randomUUID(),
        currency: 'MYR',
        rateToCny: '1.23456789',
        source: 'manual',
        businessDate: capturedAt,
        capturedAt,
        expiresAt: new Date(capturedAt.getTime() - 60000)
      }
    ]
  });
  const snapshotsBefore = await prisma.idBusinessV2FinanceFxRateSnapshot.count();
  const rates = await service.rates(operator);
  assert.equal(rates.items.length, 26);
  assert.equal(rates.items.find((item) => item.currency === 'CNY').rateToCny, '1');
  assert.equal(rates.items.find((item) => item.currency === 'PHP').rateToCny, '0.12345678');
  assert.equal(rates.items.find((item) => item.currency === 'USD').rateToCny, null);
  assert.ok(new Date(rates.items.find((item) => item.currency === 'MYR').expiresAt) < capturedAt);
  assert.equal(await prisma.idBusinessV2FinanceFxRateSnapshot.count(), snapshotsBefore);
  assert.equal(providerCalls, 0);
  assert.ok(!JSON.stringify(rates).includes('fixture-cache-private'));
  report.checks.push('26 币种纯缓存读取，无官网请求或新快照，缺失/过期保持明确且不返回原始证据');

  stage = 'ORDER_SOURCE_AND_COUNTRY';
  const privateMarker = 'fixture-job-private-canary';
  const fixtures = [
    {
      label: 'bit-valid',
      action: 'bitbrowser',
      source: 'automatic',
      result: { account_matched: true, network: { country: 'PH' } },
      amount: '100'
    },
    {
      label: 'bit-upgrade',
      action: 'bitbrowser',
      source: 'automatic',
      result: {
        account_matched: true,
        network: { country: 'PH' },
        quote: {
          today: { amount: '650.25', currency: 'PHP' },
          renewal: { amount: '1199', currency: 'PHP' }
        }
      },
      amount: '650.25'
    },
    {
      label: 'bit-mismatch',
      action: 'bitbrowser',
      source: 'automatic',
      result: { account_matched: false, network: { country: 'US' } },
      amount: '200'
    },
    {
      label: 'bit-invalid-country',
      action: 'bitbrowser',
      source: 'automatic',
      result: { account_matched: true, network: { country: 'Malaysia' } },
      amount: '300'
    },
    {
      label: 'bit-array-network',
      action: 'bitbrowser',
      source: 'automatic',
      result: { account_matched: true, network: [] },
      amount: '400'
    },
    {
      label: 'server-only',
      action: 'server',
      source: 'automatic',
      result: { account_matched: true, network: { country: 'MY' } },
      amount: '500'
    },
    { label: 'manual-only', source: 'manual', amount: '600' },
    { label: 'orphan-history', source: 'automatic', amount: '700' },
    {
      label: 'bit-recycled',
      action: 'bitbrowser',
      source: 'automatic',
      result: { account_matched: true, network: { country: 'PH' } },
      amount: '800',
      deletedAt: new Date()
    }
  ];
  const ids = new Map();
  for (const fixture of fixtures) {
    let rechargeJobId = null;
    if (fixture.action) {
      const job = await prisma.idBusinessV2RechargeJob.create({
        data: {
          id: randomUUID(),
          ownerId: operator.id,
          plan: 'plus',
          action: fixture.action,
          state: 'finished',
          result: { ...fixture.result, private_debug: privateMarker },
          leaseUntil: new Date()
        }
      });
      rechargeJobId = job.id;
    }
    const order = await prisma.idBusinessV2BankRechargeOrder.create({
      data: {
        orderNo: `QA-${randomUUID()}`,
        source: fixture.source,
        rechargeJobId,
        plan: fixture.label === 'bit-valid' ? 'go' : 'plus',
        chargeAmount: fixture.amount,
        chargeCurrencyCode: 'PHP',
        accountingVersion: 'subscription_cost_v2',
        deletedAt: fixture.deletedAt ?? null
      }
    });
    ids.set(fixture.label, order.id);
  }
  for (const status of ['login-only', 'failed']) {
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId: operator.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        result: { status, private_debug: privateMarker },
        leaseUntil: new Date()
      }
    });
  }
  const queries = new BankRechargeQueryRepository(prisma);
  const bit = await queries.list({ executionSource: 'bitbrowser', pageSize: '100' });
  assert.equal(bit.total, 5);
  assert.deepEqual(
    new Set(bit.items.map((item) => item.id)),
    new Set(
      fixtures
        .filter((fixture) => fixture.action === 'bitbrowser' && !fixture.deletedAt)
        .map((fixture) => ids.get(fixture.label))
    )
  );
  assert.equal(bit.items.find((item) => item.id === ids.get('bit-valid')).chargeCountryCode, 'PH');
  assert.equal(
    bit.items.find((item) => item.id === ids.get('bit-upgrade')).chargeAmount.toString(),
    '650.25'
  );
  for (const label of ['bit-mismatch', 'bit-invalid-country', 'bit-array-network']) {
    assert.equal(bit.items.find((item) => item.id === ids.get(label)).chargeCountryCode, null);
  }
  assert.ok(bit.items.every((item) => !Object.hasOwn(item, 'rechargeJob')));
  assert.ok(!JSON.stringify(bit).includes(privateMarker));
  assert.ok(!JSON.stringify(bit).includes('1199'));
  const historical = await queries.list({ pageSize: '100' });
  assert.equal(historical.total, 8);
  const recycled = await queries.list({ executionSource: 'bitbrowser', deleted: 'deleted' });
  assert.equal(recycled.total, 1);
  assert.equal(recycled.items[0].id, ids.get('bit-recycled'));
  await assert.rejects(queries.list({ executionSource: 'server' }), /执行来源筛选无效/);
  const countryBoundaryOrder = await prisma.idBusinessV2BankRechargeOrder.findUnique({
    where: { id: ids.get('bit-invalid-country') },
    select: { rechargeJobId: true }
  });
  for (const country of ['ZZ', 'XA', 'XB', 'QQ']) {
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: countryBoundaryOrder.rechargeJobId },
      data: {
        result: {
          account_matched: true,
          network: { country },
          private_debug: privateMarker
        }
      }
    });
    const countryBoundary = await queries.list({ executionSource: 'bitbrowser', pageSize: '100' });
    assert.equal(countryBoundary.total, 5);
    assert.equal(
      countryBoundary.items.find((item) => item.id === ids.get('bit-invalid-country'))
        .chargeCountryCode,
      null
    );
    assert.ok(!JSON.stringify(countryBoundary).includes(privateMarker));
  }
  report.checks.push('比特列表只保留有原任务的比特自动订单，其他历史记录与回收站继续保留');
  report.checks.push(
    '国家仅展示核验成功的任务出口，身份不符/无效结构显示待核验，原始任务证据不外泄'
  );
  report.checks.push('已存 Go→Plus 本次补付 650.25 原币金额原样读取，不以 1199 后续续费价覆盖');
  report.checks.push('ZZ/XA/XB/QQ 占位或未知国家返回待核验，不使列表失败或泄露原始任务');

  stage = 'HISTORY_PRESERVATION';
  const ordersBefore = await prisma.idBusinessV2BankRechargeOrder.findMany({
    orderBy: { id: 'asc' }
  });
  await service.update({ ...saved, planPrices: { ...planPrices, go: '999' } }, operator);
  assert.deepEqual(
    await prisma.idBusinessV2BankRechargeOrder.findMany({ orderBy: { id: 'asc' } }),
    ordersBefore
  );
  assert.equal(await prisma.idBusinessV2FinanceJournal.count(), 0);
  report.checks.push('调整收费配置不改历史订单、不自动建单或虚构客户已收款/财务凭证');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failedStage = stage;
  report.error =
    error instanceof assert.AssertionError ? 'ISOLATED_ASSERTION_FAILED' : 'ISOLATED_CHECK_FAILED';
  if (typeof error?.code === 'string' && /^P\d{4}$/.test(error.code))
    report.prismaCode = error.code;
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
  if (instance) {
    try {
      await instance.cleanup();
      report.cleanup = 'OWNED_INSTANCE_STOPPED_AND_REMOVED';
    } catch {
      report.cleanup = 'FAILED_OWNED_DIRECTORY_PRESERVED';
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  }
  writeFileSync(resolve(output, 'mysql-integration.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600
  });
  console.log(JSON.stringify(report));
}
