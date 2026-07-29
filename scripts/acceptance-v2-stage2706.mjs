#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertLocalAcceptanceDatabase } from './lib/development-data-cleanup.mjs';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../apps/api/dist/auth/password-hasher.js');
const {
  IdBusinessV2ExchangeRatePersistenceService,
  IdBusinessV2ExchangeRateRunError
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-exchange-rate-persistence.service.js');
const {
  IdBusinessV2OtcAverageError
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-average.service.js');

const DEFAULT_API_BASE_URL = 'http://localhost:3000/api';

function loadEnvFile(filePath) {
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      process.env[trimmed.slice(0, separator)] ??= trimmed.slice(separator + 1);
    }
  } catch {
    // Required configuration is reported by the assertions below.
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE2706_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE2706_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE2706_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;

  assert.ok(username && password, '缺少 V2706 验收管理员账号配置');
  assert.ok(databaseUrl, '缺少 V2706 验收 DATABASE_URL');
  assertLocalAcceptanceDatabase(apiBaseUrl, databaseUrl);
  const parsedDatabaseUrl = new URL(databaseUrl);
  assert.ok(
    parsedDatabaseUrl.pathname.toLowerCase().includes('v2706_acceptance'),
    'V2706 会写不可变汇率证据，只能在名称包含 v2706_acceptance 的一次性数据库运行'
  );

  const prisma = new PrismaClient();
  const suffix = `${Date.now()}`.slice(-10);
  let token = '';
  let readonlyUserId = null;

  async function request(path, options = {}) {
    const { tokenOverride, ...fetchOptions } = options;
    const requestToken = tokenOverride === undefined ? token : tokenOverride;
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        'content-type': 'application/json',
        ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}),
        ...(fetchOptions.headers ?? {})
      }
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Callers receive a short body excerpt on failure.
    }
    return { response, json, text };
  }

  async function api(path, options = {}) {
    const result = await request(path, options);
    if (!result.response.ok) {
      throw new Error(
        `${options.method ?? 'GET'} ${path} -> ${result.response.status}: ${
          result.json?.message ?? result.text.slice(0, 180)
        }`
      );
    }
    return result.json?.data;
  }

  async function waitForScheduledSuccess() {
    const deadline = Date.now() + 90_000;
    let latestOverview = null;
    while (Date.now() < deadline) {
      latestOverview = await api('/id-business-v2/exchange-rates/overview');
      if (latestOverview.lastSuccess?.triggerType === 'scheduled') {
        return latestOverview.lastSuccess;
      }
      if (
        latestOverview.latestRun?.triggerType === 'scheduled' &&
        latestOverview.latestRun.status === 'failed'
      ) {
        throw new Error(
          `自动采集真实失败：${latestOverview.latestRun.error?.code ?? 'unknown'} / ${
            latestOverview.latestRun.error?.message ?? '无安全错误摘要'
          }`
        );
      }
      await sleep(250);
    }
    throw new Error(
      `自动采集未在 90 秒内成功，最后状态为 ${latestOverview?.latestRun?.status ?? 'missing'}`
    );
  }

  function assertSnapshotFormula(snapshot, label) {
    assert.ok(snapshot, `${label}缺少综合快照`);
    const expectedMidRate = new Prisma.Decimal(snapshot.combinedMerchantBuyAverageRateToRmb)
      .plus(snapshot.combinedMerchantSellAverageRateToRmb)
      .dividedBy(2)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(8);
    assert.equal(new Prisma.Decimal(snapshot.midRateToRmb).toFixed(8), expectedMidRate);
    assert.equal(snapshot.providerSnapshotCount, 4, `${label}不是四个平台方向`);
    assert.ok(snapshot.validSampleCount >= 12, `${label}有效样本不足`);
  }

  try {
    await prisma.$connect();

    for (const path of [
      '/id-business-v2/exchange-rates',
      '/id-business-v2/exchange-rates/overview',
      '/id-business-v2/exchange-rates/runtime'
    ]) {
      const unauthorized = await request(path, { tokenOverride: null });
      assert.equal(unauthorized.response.status, 401, `未登录 ${path} 应返回 401`);
    }
    const unauthorizedCollect = await request('/id-business-v2/exchange-rates/collect', {
      method: 'POST',
      tokenOverride: null
    });
    assert.equal(unauthorizedCollect.response.status, 401, '未登录人工采集应返回 401');

    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assert.ok(login?.accessToken, '管理员登录未返回 accessToken');
    token = login.accessToken;

    const runtime = await api('/id-business-v2/exchange-rates/runtime');
    assert.equal(runtime.automaticCollectionEnabled, true, 'V2 汇率自动采集没有默认开启');
    assert.equal(runtime.runOnStartup, true, 'V2 汇率启动时自动采集没有默认开启');
    assert.ok(runtime.intervalMs >= 60_000, 'V2 汇率自动采集间隔无效');
    assert.deepEqual(runtime.providers.map((provider) => provider.code).sort(), ['binance', 'okx']);

    const scheduledSuccess = await waitForScheduledSuccess();
    assertSnapshotFormula(scheduledSuccess.snapshot, '定时采集');

    const manualSuccess = await api('/id-business-v2/exchange-rates/collect', {
      method: 'POST'
    });
    assert.equal(manualSuccess.triggerType, 'manual');
    assert.ok(manualSuccess.runId, '人工采集未返回批次编号');
    assert.ok(new Prisma.Decimal(manualSuccess.midRateToRmb).greaterThan(0));

    const manualDetail = await api(`/id-business-v2/exchange-rates/${manualSuccess.runId}`);
    assert.equal(manualDetail.status, 'success');
    assert.equal(manualDetail.triggerType, 'manual');
    assert.equal(manualDetail.triggeredBy.username, username);
    assertSnapshotFormula(manualDetail.snapshot, '人工采集');
    assert.equal(manualDetail.providerSnapshots.length, 4);
    assert.deepEqual(
      manualDetail.providerSnapshots
        .map((snapshot) => `${snapshot.provider}:${snapshot.side}`)
        .sort(),
      ['binance:merchant_buy', 'binance:merchant_sell', 'okx:merchant_buy', 'okx:merchant_sell']
    );
    assert.ok(
      manualDetail.providerSnapshots.every(
        (snapshot) =>
          snapshot.sourceUrl.startsWith('https://') &&
          snapshot.validSamples.length === snapshot.counts.valid &&
          snapshot.validSamples.every(
            (sample) =>
              !('merchantId' in sample) && !('nickName' in sample) && !('publicUserId' in sample)
          )
      ),
      '汇率详情缺少真实来源、样本数量不一致或泄露商家身份'
    );

    const filteredList = await api(
      '/id-business-v2/exchange-rates?status=success&provider=binance&page=1&pageSize=1&sortBy=startedAt&sortOrder=desc'
    );
    assert.equal(filteredList.page, 1);
    assert.equal(filteredList.pageSize, 1);
    assert.ok(filteredList.total >= 2, '成功记录列表缺少定时或人工采集');
    assert.equal(filteredList.items.length, 1);
    assert.equal(filteredList.items[0].status, 'success');
    assert.equal(
      filteredList.items[0].snapshot.providers.some((provider) => provider.provider === 'binance'),
      true
    );

    const blockingRun = await prisma.idBusinessV2ExchangeRateRun.create({
      data: {
        status: 'running',
        triggerType: 'system',
        asset: 'USDT',
        fiat: 'CNY'
      }
    });
    const conflict = await request('/id-business-v2/exchange-rates/collect', {
      method: 'POST'
    });
    assert.equal(conflict.response.status, 409, '已有数据库运行批次时人工采集应返回 409');
    assert.equal(
      await prisma.idBusinessV2ExchangeRateRun.count({ where: { status: 'running' } }),
      1,
      '多实例防重期间出现多个 running 批次'
    );
    await prisma.idBusinessV2ExchangeRateRun.update({
      where: { id: blockingRun.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorCode: 'v2706_acceptance_running_guard_released',
        errorMessage: 'V2706 隔离验收结束并发占用批次',
        errorProvider: 'system',
        errorRetryable: true,
        errorDetails: {
          source: 'v2706_isolated_acceptance',
          reason: 'running_guard_released'
        }
      }
    });

    const expectedFailure = new IdBusinessV2OtcAverageError(
      'otc_average_provider_collection_failed',
      'V2706 隔离验收明确模拟 OKX 超时',
      'OKX',
      null,
      true,
      null,
      null,
      [{ provider: 'OKX', causeCode: 'okx_otc_timeout', retryable: true }]
    );
    const failingPersistenceService = new IdBusinessV2ExchangeRatePersistenceService(prisma, {
      collectAndCalculate: async () => {
        throw expectedFailure;
      }
    });
    let simulatedFailure = null;
    try {
      await failingPersistenceService.collectAndPersist({
        triggerType: 'scheduled'
      });
    } catch (error) {
      simulatedFailure = error;
    }
    assert.ok(simulatedFailure instanceof IdBusinessV2ExchangeRateRunError);

    const overviewAfterFailure = await api('/id-business-v2/exchange-rates/overview');
    assert.equal(overviewAfterFailure.latestRun.id, simulatedFailure.runId);
    assert.equal(overviewAfterFailure.latestRun.status, 'failed');
    assert.equal(
      overviewAfterFailure.latestRun.error.code,
      'otc_average_provider_collection_failed'
    );
    assert.equal(overviewAfterFailure.latestRun.error.provider, 'okx');
    assert.equal(overviewAfterFailure.lastSuccess.id, manualSuccess.runId);
    assertSnapshotFormula(overviewAfterFailure.lastSuccess.snapshot, '失败后的最后成功结果');

    const manualAudit = await prisma.auditLog.findFirst({
      where: {
        objectId: manualSuccess.runId,
        action: 'id_business_v2.exchange_rate.collect.success'
      }
    });
    assert.ok(manualAudit, '人工采集成功没有审计日志');
    assert.ok(manualAudit.userId, '人工采集审计缺少操作人');
    const auditText = JSON.stringify(manualAudit);
    for (const forbidden of ['sourceAdId', 'merchantId', 'nickName', 'publicUserId']) {
      assert.equal(auditText.includes(forbidden), false, `审计日志泄露 ${forbidden}`);
    }

    const financeRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'finance' },
      include: {
        rolePermissions: {
          include: { permission: true }
        }
      }
    });
    const financePermissions = financeRole.rolePermissions.map((item) => item.permission.code);
    assert.equal(financePermissions.includes('apple.exchange_rate.view'), true);
    assert.equal(financePermissions.includes('apple.exchange_rate.collect'), false);

    const readonlyUsername = `v2706_finance_${suffix}`;
    const readonlyPassword = `V2706-${suffix}-Finance!`;
    const readonlyUser = await prisma.user.create({
      data: {
        username: readonlyUsername,
        passwordHash: await hashPassword(readonlyPassword),
        displayName: `V2706 只读财务 ${suffix}`,
        userRoles: {
          create: {
            roleId: financeRole.id
          }
        }
      }
    });
    readonlyUserId = readonlyUser.id;

    const readonlyLogin = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: readonlyUsername,
        password: readonlyPassword
      })
    });
    assert.ok(readonlyLogin.accessToken, '只读财务登录失败');
    const readonlyList = await request('/id-business-v2/exchange-rates', {
      tokenOverride: readonlyLogin.accessToken
    });
    assert.equal(readonlyList.response.status, 200, '只读财务不能查看汇率');
    const readonlyCollect = await request('/id-business-v2/exchange-rates/collect', {
      method: 'POST',
      tokenOverride: readonlyLogin.accessToken
    });
    assert.equal(readonlyCollect.response.status, 403, '只读财务可以执行人工采集');

    console.log(
      JSON.stringify(
        {
          ok: true,
          database: parsedDatabaseUrl.pathname.replace(/^\//, ''),
          automaticCollection: {
            enabled: runtime.automaticCollectionEnabled,
            runOnStartup: runtime.runOnStartup,
            intervalMs: runtime.intervalMs,
            scheduledRunId: scheduledSuccess.id
          },
          manualCollection: {
            runId: manualSuccess.runId,
            providerSnapshotCount: manualDetail.providerSnapshots.length,
            validSampleCount: manualDetail.snapshot.validSampleCount,
            combinedMerchantBuyAverageRateToRmb:
              manualDetail.snapshot.combinedMerchantBuyAverageRateToRmb,
            combinedMerchantSellAverageRateToRmb:
              manualDetail.snapshot.combinedMerchantSellAverageRateToRmb,
            midRateToRmb: manualDetail.snapshot.midRateToRmb
          },
          failureBoundary: {
            latestRunStatus: overviewAfterFailure.latestRun.status,
            latestFailureCode: overviewAfterFailure.latestRun.error.code,
            latestFailureProvider: overviewAfterFailure.latestRun.error.provider,
            lastSuccessRunId: overviewAfterFailure.lastSuccess.id
          },
          permissions: {
            unauthenticatedRejected: true,
            financeCanView: true,
            financeCannotCollect: true
          },
          guards: {
            oneDatabaseRunningBatch: true,
            latestFailureDoesNotReplaceLastSuccess: true,
            detailHasFourProviderSides: true,
            auditContainsNoQuoteOrMerchantIdentity: true
          }
        },
        null,
        2
      )
    );
  } finally {
    if (readonlyUserId) {
      await prisma.activeSession.deleteMany({ where: { userId: readonlyUserId } });
      await prisma.user.deleteMany({ where: { id: readonlyUserId } });
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
