#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { isLocalDatabaseUrl } from './lib/development-data-cleanup.mjs';

const require = createRequire(import.meta.url);
const {
  IdBusinessV2BinanceOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-binance-otc.collector.js');
const {
  IdBusinessV2OkxOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-okx-otc.collector.js');
const {
  IdBusinessV2OtcAverageError,
  IdBusinessV2OtcAverageService
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-average.service.js');
const {
  IdBusinessV2OtcMidRateService
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-mid-rate.service.js');
const {
  IdBusinessV2ExchangeRatePersistenceService,
  IdBusinessV2ExchangeRateRunError
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-exchange-rate-persistence.service.js');

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
    // Missing configuration is reported below.
  }
}

loadEnvFile('.env');
loadEnvFile('apps/api/.env');

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'V2705 验收缺少 DATABASE_URL');
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  parsedDatabaseUrl.pathname.toLowerCase().includes('v2705_acceptance'),
  'V2705 会写不可变汇率证据，只能在名称包含 v2705_acceptance 的隔离数据库运行'
);
assert.ok(
  isLocalDatabaseUrl(databaseUrl) || process.env.ACCEPTANCE_ALLOW_REMOTE_DATABASE === '1',
  'V2705 默认拒绝远程数据库；仅确认远程隔离库允许写入时才可设置 ACCEPTANCE_ALLOW_REMOTE_DATABASE=1'
);

const prisma = new PrismaClient();

try {
  await prisma.$connect();

  const averageService = new IdBusinessV2OtcAverageService(
    new IdBusinessV2BinanceOtcCollector(),
    new IdBusinessV2OkxOtcCollector()
  );
  const midRateService = new IdBusinessV2OtcMidRateService(averageService);
  const persistenceService = new IdBusinessV2ExchangeRatePersistenceService(prisma, midRateService);
  const success = await persistenceService.collectAndPersist({
    triggerType: 'system'
  });

  const persistedSuccess = await prisma.idBusinessV2ExchangeRateRun.findUniqueOrThrow({
    where: { id: success.runId },
    include: {
      snapshot: {
        include: {
          providerSnapshots: {
            include: {
              validSamples: true
            }
          }
        }
      }
    }
  });

  assert.equal(persistedSuccess.status, 'success');
  assert.ok(persistedSuccess.finishedAt);
  assert.equal(persistedSuccess.errorCode, null);
  assert.ok(persistedSuccess.snapshot);
  assert.equal(persistedSuccess.snapshot.providerSnapshots.length, 4);
  assert.equal(
    persistedSuccess.snapshot.combinedMerchantBuyAverageRateToRmb.toString(),
    success.combinedMerchantBuyAverageRateToRmb.toString()
  );
  assert.equal(
    persistedSuccess.snapshot.combinedMerchantSellAverageRateToRmb.toString(),
    success.combinedMerchantSellAverageRateToRmb.toString()
  );
  assert.equal(persistedSuccess.snapshot.midRateToRmb.toString(), success.midRateToRmb.toString());

  const requiredPairs = new Set([
    'binance:merchant_buy',
    'binance:merchant_sell',
    'okx:merchant_buy',
    'okx:merchant_sell'
  ]);
  let persistedSampleCount = 0;
  for (const providerSnapshot of persistedSuccess.snapshot.providerSnapshots) {
    requiredPairs.delete(`${providerSnapshot.provider}:${providerSnapshot.side}`);
    assert.equal(providerSnapshot.validSamples.length, providerSnapshot.validAdCount);
    assert.equal(
      providerSnapshot.collectorAcceptedAdCount,
      providerSnapshot.validAdCount + providerSnapshot.filteredAdCount
    );
    assert.equal(
      providerSnapshot.receivedAdCount,
      providerSnapshot.collectorAcceptedAdCount + providerSnapshot.collectorRejectedAdCount
    );
    assert.ok(
      providerSnapshot.validSamples.every(
        (sample) =>
          sample.priceToRmb.greaterThan(0) &&
          sample.tradableAmountUsdt.greaterThan(0) &&
          sample.completedOrderCount >= 10 &&
          sample.completionRate.greaterThanOrEqualTo('0.9')
      )
    );
    persistedSampleCount += providerSnapshot.validSamples.length;
  }
  assert.equal(requiredPairs.size, 0);
  assert.equal(persistedSampleCount, success.validSampleCount);

  const successAudit = await prisma.auditLog.findFirst({
    where: {
      objectId: success.runId,
      action: 'id_business_v2.exchange_rate.collect.success'
    }
  });
  assert.ok(successAudit);
  assert.equal(JSON.stringify(successAudit).includes('sourceAdId'), false);
  assert.equal(JSON.stringify(successAudit).includes('merchantId'), false);

  const expectedFailure = new IdBusinessV2OtcAverageError(
    'otc_average_provider_collection_failed',
    'V2705 隔离验收明确模拟 OKX 超时',
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

  let failureRunError = null;
  try {
    await failingPersistenceService.collectAndPersist({
      triggerType: 'scheduled'
    });
  } catch (error) {
    failureRunError = error;
  }
  assert.ok(failureRunError instanceof IdBusinessV2ExchangeRateRunError);
  assert.equal(failureRunError.code, 'otc_average_provider_collection_failed');
  assert.equal(failureRunError.provider, 'okx');
  assert.equal(failureRunError.retryable, true);

  const persistedFailure = await prisma.idBusinessV2ExchangeRateRun.findUniqueOrThrow({
    where: { id: failureRunError.runId },
    include: {
      snapshot: true
    }
  });
  assert.equal(persistedFailure.status, 'failed');
  assert.equal(persistedFailure.errorCode, 'otc_average_provider_collection_failed');
  assert.equal(persistedFailure.errorProvider, 'okx');
  assert.equal(persistedFailure.errorRetryable, true);
  assert.equal(persistedFailure.snapshot, null);

  await assert.rejects(
    prisma.idBusinessV2ExchangeRateSnapshot.update({
      where: { id: success.snapshotId },
      data: {
        midRateToRmb: success.midRateToRmb.plus('0.01')
      }
    }),
    /immutable/
  );

  await assert.rejects(
    prisma.idBusinessV2ExchangeRateRun.create({
      data: {
        status: 'success',
        triggerType: 'system',
        asset: 'USDT',
        fiat: 'CNY',
        startedAt: new Date(Date.now() - 1_000),
        finishedAt: new Date(),
        policyMinCompletedOrderCount: 10,
        policyMinCompletionRate: '0.9',
        policyMaxPriceDeviationRate: '0.03',
        policyMinValidAdsPerSide: 3,
        policyDecimalPlaces: 8
      }
    }),
    /requires exactly one snapshot/
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        database: parsedDatabaseUrl.pathname.replace(/^\//, ''),
        success: {
          status: persistedSuccess.status,
          triggerType: persistedSuccess.triggerType,
          averagedAt: persistedSuccess.snapshot.averagedAt.toISOString(),
          providerSnapshotCount: persistedSuccess.snapshot.providerSnapshots.length,
          validSampleCount: persistedSampleCount,
          combinedMerchantBuyAverageRateToRmb:
            persistedSuccess.snapshot.combinedMerchantBuyAverageRateToRmb.toString(),
          combinedMerchantSellAverageRateToRmb:
            persistedSuccess.snapshot.combinedMerchantSellAverageRateToRmb.toString(),
          midRateToRmb: persistedSuccess.snapshot.midRateToRmb.toString()
        },
        failure: {
          status: persistedFailure.status,
          errorCode: persistedFailure.errorCode,
          errorProvider: persistedFailure.errorProvider,
          retryable: persistedFailure.errorRetryable,
          hasSnapshot: Boolean(persistedFailure.snapshot)
        },
        databaseGuards: {
          successRequiresCompleteSnapshot: true,
          snapshotEvidenceIsImmutable: true,
          sampleCountsReconciled: true
        },
        deferred: {
          queryApiAndPage: 'V2706'
        }
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}
