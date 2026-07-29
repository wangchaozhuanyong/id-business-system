#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertLocalAcceptanceDatabase } from './lib/development-data-cleanup.mjs';

const require = createRequire(import.meta.url);
const {
  FieldEncryptionService
} = require('../apps/api/dist/common/crypto/field-encryption.service.js');
const {
  IdBusinessV2BalanceCalculatorService
} = require('../apps/api/dist/id-business-v2/balances/id-business-v2-balance-calculator.service.js');
const {
  IdBusinessV2GiftCardCreditService
} = require('../apps/api/dist/id-business-v2/gift-cards/id-business-v2-gift-card-credit.service.js');

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
    // Required configuration is reported below.
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

function assertDecimal(actual, expected, label) {
  const normalizedActual = new Prisma.Decimal(actual);
  const normalizedExpected = new Prisma.Decimal(expected);
  assert.ok(
    normalizedActual.equals(normalizedExpected),
    `${label}不一致，预期 ${normalizedExpected.toString()}，实际 ${normalizedActual.toString()}`
  );
}

function decimalSum(values) {
  return values.reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0));
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE2802_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE2802_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE2802_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;

  assert.ok(username && password, '缺少 V2802 验收管理员账号配置');
  assert.ok(databaseUrl, '缺少 V2802 验收 DATABASE_URL');
  assertLocalAcceptanceDatabase(apiBaseUrl, databaseUrl);
  assert.ok(
    new URL(databaseUrl).pathname.toLowerCase().endsWith('/v2802_acceptance'),
    'V2802 只能在名称为 v2802_acceptance 的一次性数据库运行'
  );

  const prisma = new PrismaClient();
  const suffix = `${Date.now()}`.slice(-10);
  const optionIds = [];
  const customerIds = [];
  const accountIds = [];
  const giftCardIds = [];
  const orderIds = [];
  const objectIds = new Set();
  let token = '';
  let primaryError = null;
  const cleanupErrors = [];
  let resultSummary = null;

  async function request(path, options = {}) {
    const isFormData = options.body instanceof FormData;
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        ...(!isFormData ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Callers receive a short non-sensitive body excerpt on failure.
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

  async function createOption(type, name, parentId = null, extra = {}) {
    const option = await api('/id-business-v2/options', {
      method: 'POST',
      body: JSON.stringify({
        type,
        name,
        parentId,
        remark: `V2802 transaction QA ${suffix}`,
        ...extra
      })
    });
    optionIds.push(option.id);
    objectIds.add(option.id);
    return option;
  }

  async function createAccount(input) {
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    accountIds.push(account.id);
    objectIds.add(account.id);
    return account;
  }

  async function creditAccount({
    accountId,
    supplierOptionId,
    code,
    faceValue,
    exchangeRate,
    idempotencyKey,
    remark
  }) {
    const form = new FormData();
    form.set('code', code);
    form.set('faceValue', faceValue);
    form.set('exchangeRate', exchangeRate);
    form.set('supplierOptionId', supplierOptionId);
    form.set('idempotencyKey', idempotencyKey);
    form.set('remark', remark);
    const result = await api(`/id-business-v2/gift-cards/${accountId}/credits`, {
      method: 'POST',
      body: form
    });
    if (!giftCardIds.includes(result.giftCard.id)) giftCardIds.push(result.giftCard.id);
    objectIds.add(result.giftCard.id);
    objectIds.add(result.ledgerEntry.id);
    return result;
  }

  function buildOrderInput({
    customerId,
    serviceOptionId,
    accountId,
    settlementPlatformOptionId,
    platformOrderNo,
    receivedAmount,
    balanceAmount,
    idempotencyKey,
    sortOrder
  }) {
    const openedAt = new Date();
    const dueAt = new Date(openedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    return {
      customerId,
      serviceOptionId,
      accountId,
      settlementPlatformOptionId,
      platformOrderNo,
      websiteAccount: `v2802.${idempotencyKey}@example.com`,
      receivedAmount,
      balanceAmount,
      openedAt: openedAt.toISOString(),
      dueAt: dueAt.toISOString(),
      lockScope: 'by_service',
      idempotencyKey,
      sortOrder,
      remark: `V2802 order ${idempotencyKey}`
    };
  }

  function rememberOrder(result) {
    if (!orderIds.includes(result.order.id)) orderIds.push(result.order.id);
    objectIds.add(result.order.id);
    if (result.lock?.id) objectIds.add(result.lock.id);
    return result;
  }

  async function createOrder(input) {
    return rememberOrder(
      await api('/id-business-v2/orders', {
        method: 'POST',
        body: JSON.stringify(input)
      })
    );
  }

  async function reverseGiftCard(giftCardId, action, marker) {
    const result = await api(`/id-business-v2/gift-cards/${giftCardId}/reversals`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        reason: `V2802 ${action} ${suffix}`,
        idempotencyKey: `v2802-${marker}-${suffix}`
      })
    });
    objectIds.add(result.ledgerEntry.id);
    return result;
  }

  async function cleanup() {
    const knownObjectIds = [...objectIds].filter(Boolean);
    if (knownObjectIds.length) {
      await prisma.sensitiveAccessLog.deleteMany({
        where: { objectId: { in: knownObjectIds } }
      });
      await prisma.auditLog.deleteMany({
        where: { objectId: { in: knownObjectIds } }
      });
    }
    if (accountIds.length || orderIds.length || giftCardIds.length) {
      await prisma.idBusinessV2BalanceLedger.deleteMany({
        where: {
          OR: [
            ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
            ...(giftCardIds.length ? [{ giftCardId: { in: giftCardIds } }] : [])
          ]
        }
      });
    }
    if (orderIds.length) {
      await prisma.idBusinessV2Activation.deleteMany({
        where: { orderId: { in: orderIds } }
      });
      await prisma.idBusinessV2AccountLock.deleteMany({
        where: { orderId: { in: orderIds } }
      });
      await prisma.idBusinessV2Order.deleteMany({
        where: { id: { in: orderIds } }
      });
    }
    if (giftCardIds.length) {
      await prisma.idBusinessV2GiftCard.deleteMany({
        where: { id: { in: giftCardIds } }
      });
    }
    if (accountIds.length) {
      await prisma.idBusinessV2Account.deleteMany({
        where: { id: { in: accountIds } }
      });
    }
    if (customerIds.length) {
      await prisma.idBusinessV2Customer.deleteMany({
        where: { id: { in: customerIds } }
      });
    }
    for (const optionId of [...optionIds].reverse()) {
      await prisma.idBusinessV2Option.deleteMany({ where: { id: optionId } });
    }
  }

  try {
    await prisma.$connect();

    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assert.ok(login?.accessToken, '管理员登录未返回 accessToken');
    token = login.accessToken;

    const statusSelectors = await api('/id-business-v2/options/selectors?type=id_status');
    const normalStatus = statusSelectors.items.find((item) => item.code === 'normal');
    assert.ok(normalStatus, '缺少系统固定 ID 状态 normal');

    const regionAndCountryName = `V2802 美国 ${suffix}`;
    const country = await createOption('country', regionAndCountryName, null, {
      currencyCode: 'USD'
    });
    const category = await createOption('business_category', `V2802 分类 ${suffix}`);
    const serviceA = await createOption('service', `V2802 业务 A ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const serviceB = await createOption('service', `V2802 业务 B ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '15'
    });
    const idSupplier = await createOption('id_supplier', `V2802 ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `V2802 加卡供应商 ${suffix}`);
    const settlementPlatform = await createOption(
      'settlement_platform',
      `V2802 结算平台 ${suffix}`,
      null,
      { fixedFee: '1', percentageFee: '2' }
    );

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `V2802 客户 ${suffix}`,
        serviceOptionIds: [serviceA.id, serviceB.id],
        sortOrder: 2802,
        remark: 'V2802 账务验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);

    const mainAccount = await createAccount({
      appleId: `v2802.main.${suffix}@example.com`,
      password: `V2802-${suffix}-Main!`,
      countryOptionId: country.id,
      statusOptionId: normalStatus.id,
      supplierOptionId: idSupplier.id,
      purchaseCost: '25',
      sortOrder: 2802,
      remark: 'V2802 主账务 ID'
    });
    const rollbackAccount = await createAccount({
      appleId: `v2802.rollback.${suffix}@example.com`,
      password: `V2802-${suffix}-Rollback!`,
      countryOptionId: country.id,
      statusOptionId: normalStatus.id,
      supplierOptionId: idSupplier.id,
      purchaseCost: '10',
      sortOrder: 2803,
      remark: 'V2802 事务回滚 ID'
    });

    const firstCode = `V2802${suffix}FIRSTCARD`;
    const firstCredit = await creditAccount({
      accountId: mainAccount.id,
      supplierOptionId: topupSupplier.id,
      code: firstCode,
      faceValue: '10',
      exchangeRate: '2',
      idempotencyKey: `credit-first-${suffix}`,
      remark: 'V2802 first weighted credit'
    });
    assertDecimal(firstCredit.ledgerEntry.balanceBefore, '0', '首次加卡前余额');
    assertDecimal(firstCredit.ledgerEntry.balanceAfter, '10', '首次加卡后余额');
    assertDecimal(firstCredit.ledgerEntry.costAfter, '20', '首次加卡后成本');
    assertDecimal(firstCredit.ledgerEntry.averageCostAfter, '2', '首次加卡后平均成本');

    const secondCode = `V2802${suffix}SECONDCARD`;
    const secondCredit = await creditAccount({
      accountId: mainAccount.id,
      supplierOptionId: topupSupplier.id,
      code: secondCode,
      faceValue: '30',
      exchangeRate: '4',
      idempotencyKey: `credit-second-${suffix}`,
      remark: 'V2802 second weighted credit'
    });
    assertDecimal(secondCredit.ledgerEntry.balanceBefore, '10', '二次加卡前余额');
    assertDecimal(secondCredit.ledgerEntry.balanceAfter, '40', '二次加卡后余额');
    assertDecimal(secondCredit.ledgerEntry.costBefore, '20', '二次加卡前成本');
    assertDecimal(secondCredit.ledgerEntry.costAfter, '140', '二次加卡后成本');
    assertDecimal(secondCredit.ledgerEntry.averageCostAfter, '3.5', '移动加权平均成本');

    const secondReplay = await creditAccount({
      accountId: mainAccount.id,
      supplierOptionId: topupSupplier.id,
      code: secondCode,
      faceValue: '30',
      exchangeRate: '4',
      idempotencyKey: `credit-second-${suffix}`,
      remark: 'V2802 second weighted credit'
    });
    assert.equal(secondReplay.idempotentReplay, true, '重复加卡没有幂等返回');
    assert.equal(secondReplay.ledgerEntry.id, secondCredit.ledgerEntry.id);
    assert.equal(
      await prisma.idBusinessV2GiftCard.count({ where: { accountId: mainAccount.id } }),
      2,
      '重复加卡创建了多余礼品卡'
    );

    const configService = {
      get(key) {
        return process.env[key];
      }
    };
    const creditService = new IdBusinessV2GiftCardCreditService(
      prisma,
      new FieldEncryptionService(configService),
      new IdBusinessV2BalanceCalculatorService()
    );
    let transactionHookReached = false;
    let injectedGiftCardId = null;
    let injectedFailure = null;
    try {
      await creditService.confirmCredit(
        rollbackAccount.id,
        {
          code: `V2802${suffix}ROLLBACKCARD`,
          faceValue: '9',
          exchangeRate: '9',
          supplierOptionId: topupSupplier.id,
          idempotencyKey: `rollback-credit-${suffix}`,
          remark: 'V2802 injected transaction failure'
        },
        undefined,
        undefined,
        undefined,
        async (context) => {
          transactionHookReached = true;
          injectedGiftCardId = context.giftCardId;
          throw new Error('v2802_injected_transaction_failure');
        }
      );
    } catch (error) {
      injectedFailure = error;
    }
    assert.equal(transactionHookReached, true, '事务失败钩子没有在完整写路径后执行');
    assert.ok(injectedGiftCardId, '事务失败钩子没有返回已写入的礼品卡 ID');
    assert.match(String(injectedFailure), /v2802_injected_transaction_failure/);
    const rollbackStoredAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: rollbackAccount.id }
    });
    assertDecimal(rollbackStoredAccount.currentBalance, '0', '事务失败后 ID 余额');
    assertDecimal(rollbackStoredAccount.balanceCostAmount, '0', '事务失败后 ID 成本');
    assert.equal(
      await prisma.idBusinessV2GiftCard.count({ where: { accountId: rollbackAccount.id } }),
      0,
      '事务失败后遗留礼品卡'
    );
    assert.equal(
      await prisma.idBusinessV2BalanceLedger.count({ where: { accountId: rollbackAccount.id } }),
      0,
      '事务失败后遗留余额流水'
    );

    const rollbackCard = await creditAccount({
      accountId: rollbackAccount.id,
      supplierOptionId: topupSupplier.id,
      code: `V2802${suffix}WITHDRAWCARD`,
      faceValue: '5',
      exchangeRate: '3',
      idempotencyKey: `withdraw-credit-${suffix}`,
      remark: 'V2802 withdrawal card'
    });
    const withdrawn = await reverseGiftCard(rollbackCard.giftCard.id, 'withdrawn', 'withdrawal');
    assert.equal(withdrawn.giftCard.status, 'withdrawn');
    assertDecimal(withdrawn.account.currentBalance, '0', '撤回后独立 ID 余额');
    assertDecimal(withdrawn.account.balanceCostAmount, '0', '撤回后独立 ID 成本');

    const insufficientInput = buildOrderInput({
      customerId: customer.id,
      serviceOptionId: serviceB.id,
      accountId: mainAccount.id,
      settlementPlatformOptionId: settlementPlatform.id,
      platformOrderNo: `V2802-INSUFFICIENT-${suffix}`,
      receivedAmount: '100',
      balanceAmount: '41',
      idempotencyKey: `order-insufficient-${suffix}`,
      sortOrder: 2804
    });
    const insufficient = await request('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify(insufficientInput)
    });
    assert.equal(insufficient.response.status, 409, '余额不足订单没有返回 409');
    assert.equal(
      await prisma.idBusinessV2Order.count({
        where: { idempotencyKey: `order_entry:${insufficientInput.idempotencyKey}` }
      }),
      0,
      '余额不足事务遗留订单'
    );

    const matching = await api(
      `/id-business-v2/orders/matching-candidates?serviceOptionId=${serviceA.id}&balanceAmount=20&limit=20`
    );
    assert.equal(matching.selectedCandidateId, mainAccount.id, '自动匹配没有选中主 ID');

    const concurrentInputs = [
      buildOrderInput({
        customerId: customer.id,
        serviceOptionId: serviceA.id,
        accountId: mainAccount.id,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `V2802-LOCK-A-${suffix}`,
        receivedAmount: '100',
        balanceAmount: '20',
        idempotencyKey: `order-lock-a-${suffix}`,
        sortOrder: 2805
      }),
      buildOrderInput({
        customerId: customer.id,
        serviceOptionId: serviceA.id,
        accountId: mainAccount.id,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `V2802-LOCK-B-${suffix}`,
        receivedAmount: '100',
        balanceAmount: '20',
        idempotencyKey: `order-lock-b-${suffix}`,
        sortOrder: 2806
      })
    ];
    const concurrentOrderResults = await Promise.all(
      concurrentInputs.map(async (input) => ({
        input,
        result: await request('/id-business-v2/orders', {
          method: 'POST',
          body: JSON.stringify(input)
        })
      }))
    );
    const successfulOrderRequests = concurrentOrderResults.filter(
      ({ result }) => result.response.ok
    );
    const conflictingOrderRequests = concurrentOrderResults.filter(
      ({ result }) => result.response.status === 409
    );
    assert.equal(successfulOrderRequests.length, 1, '并发锁定没有且仅有一笔订单成功');
    assert.equal(conflictingOrderRequests.length, 1, '并发锁定失败请求没有返回 409');
    const successfulOrderRequest = successfulOrderRequests[0];
    const mainOrder = rememberOrder(successfulOrderRequest.result.json.data);
    assert.equal(
      await prisma.idBusinessV2Order.count({
        where: {
          idempotencyKey: {
            in: concurrentInputs.map((input) => `order_entry:${input.idempotencyKey}`)
          }
        }
      }),
      1,
      '并发冲突遗留第二笔订单'
    );
    assert.equal(
      await prisma.idBusinessV2AccountLock.count({
        where: {
          accountId: mainAccount.id,
          serviceOptionId: serviceA.id,
          status: 'active'
        }
      }),
      1,
      '并发冲突产生了多个活动锁'
    );

    const orderReplay = await api('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify(successfulOrderRequest.input)
    });
    assert.equal(orderReplay.idempotentReplay, true, '订单创建重放没有幂等返回');
    assert.equal(orderReplay.order.id, mainOrder.order.id);

    const consumeKey = `consume-main-${suffix}`;
    const concurrentConsumption = await Promise.all([
      request(`/id-business-v2/orders/${mainOrder.order.id}/consume-balance`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: consumeKey })
      }),
      request(`/id-business-v2/orders/${mainOrder.order.id}/consume-balance`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: consumeKey })
      })
    ]);
    assert.ok(
      concurrentConsumption.every((result) => result.response.ok),
      `相同幂等键并发扣款存在失败：${concurrentConsumption
        .map((result) => result.response.status)
        .join(',')}`
    );
    const consumptionResults = concurrentConsumption.map((result) => result.json.data);
    assert.equal(
      new Set(consumptionResults.map((result) => result.ledgerEntry.id)).size,
      1,
      '相同幂等键并发扣款返回了不同流水'
    );
    assert.equal(
      await prisma.idBusinessV2BalanceLedger.count({
        where: { orderId: mainOrder.order.id, entryType: 'order_consumption' }
      }),
      1,
      '相同幂等键并发扣款写入多条流水'
    );
    const mainConsumption = consumptionResults[0];
    objectIds.add(mainConsumption.ledgerEntry.id);
    assertDecimal(mainConsumption.ledgerEntry.balanceBefore, '40', '主订单扣款前余额');
    assertDecimal(mainConsumption.ledgerEntry.balanceAfter, '20', '主订单扣款后余额');
    assertDecimal(mainConsumption.ledgerEntry.costAmount, '70', '主订单余额成本');
    assertDecimal(mainConsumption.order.profitAmount, '27', '主订单利润');

    const cancelledMain = await api(`/id-business-v2/orders/${mainOrder.order.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        reason: 'V2802 未开通订单取消',
        idempotencyKey: `cancel-main-${suffix}`
      })
    });
    objectIds.add(cancelledMain.reversalLedger.id);
    assert.equal(cancelledMain.balanceRestored, true);
    assertDecimal(cancelledMain.order.balanceCostAmount, '0', '取消订单成本归零');
    assertDecimal(cancelledMain.reversalLedger.balanceAfter, '40', '取消后恢复余额');
    assertDecimal(cancelledMain.reversalLedger.costAfter, '140', '取消后恢复成本');

    const orderB = await createOrder(
      buildOrderInput({
        customerId: customer.id,
        serviceOptionId: serviceA.id,
        accountId: mainAccount.id,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `V2802-REFUND-NO-${suffix}`,
        receivedAmount: '70',
        balanceAmount: '10',
        idempotencyKey: `order-refund-no-${suffix}`,
        sortOrder: 2807
      })
    );
    const consumedB = await api(`/id-business-v2/orders/${orderB.order.id}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `consume-refund-no-${suffix}` })
    });
    objectIds.add(consumedB.ledgerEntry.id);
    const completedB = await api(`/id-business-v2/orders/${orderB.order.id}/complete`, {
      method: 'POST'
    });
    objectIds.add(completedB.activation.id);
    assert.equal(completedB.order.status, 'completed', '完成订单没有进入 completed');
    assert.equal(completedB.activation.status, 'active', '完成订单没有生成活动开通记录');
    assert.equal(
      completedB.consumptionLedgerId,
      consumedB.ledgerEntry.id,
      '开通记录没有引用真实扣款流水'
    );
    const refundedWithoutBalance = await api(`/id-business-v2/orders/${orderB.order.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({
        refundCostAmount: '7',
        reason: 'V2802 退款不恢复余额',
        restoreBalance: false,
        idempotencyKey: `refund-no-${suffix}`
      })
    });
    assert.equal(refundedWithoutBalance.balanceRestored, false);
    assert.equal(refundedWithoutBalance.reversalLedger, null);
    assertDecimal(refundedWithoutBalance.order.profitAmount, '25.6', '不恢复余额退款利润');

    const orderC = await createOrder(
      buildOrderInput({
        customerId: customer.id,
        serviceOptionId: serviceA.id,
        accountId: mainAccount.id,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `V2802-REFUND-YES-${suffix}`,
        receivedAmount: '50',
        balanceAmount: '5',
        idempotencyKey: `order-refund-yes-${suffix}`,
        sortOrder: 2808
      })
    );
    const consumedC = await api(`/id-business-v2/orders/${orderC.order.id}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `consume-refund-yes-${suffix}` })
    });
    objectIds.add(consumedC.ledgerEntry.id);
    const refundedWithBalance = await api(`/id-business-v2/orders/${orderC.order.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({
        refundCostAmount: '4',
        reason: 'V2802 退款恢复余额',
        restoreBalance: true,
        idempotencyKey: `refund-yes-${suffix}`
      })
    });
    objectIds.add(refundedWithBalance.reversalLedger.id);
    assert.equal(refundedWithBalance.balanceRestored, true);
    assertDecimal(refundedWithBalance.reversalLedger.balanceAfter, '30', '退款恢复后余额');
    assertDecimal(refundedWithBalance.reversalLedger.costAfter, '105', '退款恢复后成本');
    assertDecimal(refundedWithBalance.order.profitAmount, '44', '恢复余额退款利润');

    const redeemed = await reverseGiftCard(firstCredit.giftCard.id, 'redeemed', 'redeemed');
    assert.equal(redeemed.giftCard.status, 'redeemed');
    assertDecimal(redeemed.ledgerEntry.balanceAmount, '10', '被赎回余额');
    assertDecimal(redeemed.ledgerEntry.costAmount, '35', '被赎回成本');
    assertDecimal(redeemed.account.currentBalance, '20', '被赎回后主 ID 余额');
    assertDecimal(redeemed.account.balanceCostAmount, '70', '被赎回后主 ID 成本');

    let immutableUpdateError = null;
    try {
      await prisma.$executeRawUnsafe(
        'UPDATE "id_business_v2_balance_ledger" SET "balance_after" = 999 WHERE "id" = $1::uuid',
        firstCredit.ledgerEntry.id
      );
    } catch (error) {
      immutableUpdateError = error;
    }
    assert.ok(immutableUpdateError, '直接更新余额流水没有被数据库拒绝');
    assert.match(String(immutableUpdateError), /V2 balance ledger is immutable/);
    const immutableEntry = await prisma.idBusinessV2BalanceLedger.findUniqueOrThrow({
      where: { id: firstCredit.ledgerEntry.id }
    });
    assertDecimal(immutableEntry.balanceAfter, '10', '防篡改后的首次流水余额');

    const mainLedgers = await prisma.idBusinessV2BalanceLedger.findMany({
      where: { accountId: mainAccount.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    assert.equal(mainLedgers.length, 8, '主 ID 流水数量不正确');
    for (let index = 1; index < mainLedgers.length; index += 1) {
      assertDecimal(
        mainLedgers[index].balanceBefore,
        mainLedgers[index - 1].balanceAfter,
        `第 ${index + 1} 笔流水余额连续性`
      );
      assertDecimal(
        mainLedgers[index].costBefore,
        mainLedgers[index - 1].costAfter,
        `第 ${index + 1} 笔流水成本连续性`
      );
    }
    const balanceNet = decimalSum(
      mainLedgers.map((entry) =>
        entry.direction === 'credit' ? entry.balanceAmount : entry.balanceAmount.negated()
      )
    );
    const costNet = decimalSum(
      mainLedgers.map((entry) =>
        entry.direction === 'credit' ? entry.costAmount : entry.costAmount.negated()
      )
    );
    const finalAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: mainAccount.id }
    });
    assertDecimal(finalAccount.currentBalance, balanceNet, '账户余额与流水净额');
    assertDecimal(finalAccount.balanceCostAmount, costNet, '账户成本与流水净额');
    assertDecimal(finalAccount.currentBalance, '20', '主 ID 最终余额');
    assertDecimal(finalAccount.balanceCostAmount, '70', '主 ID 最终成本');
    assertDecimal(
      finalAccount.balanceCostAmount.dividedBy(finalAccount.currentBalance),
      '3.5',
      '主 ID 最终平均成本'
    );

    const orphanCounts = {
      failedCreditGiftCards: await prisma.idBusinessV2GiftCard.count({
        where: {
          accountId: rollbackAccount.id,
          remark: 'V2802 injected transaction failure'
        }
      }),
      failedCreditLedgers: await prisma.idBusinessV2BalanceLedger.count({
        where: {
          accountId: rollbackAccount.id,
          remark: 'V2802 injected transaction failure'
        }
      }),
      failedCreditAudits: await prisma.auditLog.count({
        where: {
          objectId: injectedGiftCardId,
          action: 'id_business_v2.gift_card.credit'
        }
      }),
      insufficientOrders: await prisma.idBusinessV2Order.count({
        where: { idempotencyKey: `order_entry:${insufficientInput.idempotencyKey}` }
      }),
      duplicateMainConsumption: await prisma.idBusinessV2BalanceLedger.count({
        where: {
          orderId: mainOrder.order.id,
          entryType: 'order_consumption'
        }
      })
    };
    assert.deepEqual(orphanCounts, {
      failedCreditGiftCards: 0,
      failedCreditLedgers: 0,
      failedCreditAudits: 0,
      insufficientOrders: 0,
      duplicateMainConsumption: 1
    });

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        emptyDatabaseMigrationGuard: true,
        twoCreditsUseMovingWeightedAverage: true,
        creditReplayDoesNotDoublePost: true,
        injectedMidTransactionFailureRollsBackEverything: true,
        insufficientBalanceRollsBackOrderAndLock: true,
        concurrentAccountLockAllowsOneOrder: true,
        concurrentConsumptionWritesOneLedger: true,
        completedOrderCreatesActivationFromConsumption: true,
        cancellationRestoresExactSnapshot: true,
        refundWithoutBalanceRestoration: true,
        refundWithBalanceRestoration: true,
        redeemedAndWithdrawnUseRealReverseLedgers: true,
        databaseRejectsLedgerMutation: true,
        accountTotalsEqualImmutableLedgerNet: true,
        noOrphanSuccessState: true
      },
      finalMainAccount: {
        balance: finalAccount.currentBalance.toString(),
        balanceCostAmount: finalAccount.balanceCostAmount.toString(),
        averageCost: finalAccount.balanceCostAmount
          .dividedBy(finalAccount.currentBalance)
          .toString(),
        ledgerCount: mainLedgers.length
      },
      orphanCounts,
      cleanup: 'completed'
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    await prisma.$disconnect();
  }

  if (primaryError) throw primaryError;
  if (cleanupErrors.length) {
    throw new Error(`V2802 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`V2802 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
