#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertLocalAcceptanceDatabase } from './lib/development-data-cleanup.mjs';

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
    // Required configuration is reported by the checks below.
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDecimal(actual, expected, label) {
  const actualDecimal = new Prisma.Decimal(actual);
  assert(
    actualDecimal.equals(expected),
    `${label}不一致，预期 ${expected}，实际 ${actualDecimal.toString()}`
  );
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE7_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE7_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE7_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const keepData = process.env.V2_STAGE7_ACCEPTANCE_KEEP_DATA === '1';

  assert(username && password, '缺少 Stage 7 验收管理员账号配置');
  assertLocalAcceptanceDatabase(apiBaseUrl, process.env.DATABASE_URL);

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
      // The caller receives a short body excerpt without printing credentials.
    }
    return { response, json, text };
  }

  async function api(path, options = {}) {
    const result = await request(path, options);
    if (!result.response.ok) {
      throw new Error(
        `${options.method ?? 'GET'} ${path} -> ${result.response.status}: ${
          result.json?.message ?? result.text.slice(0, 160)
        }`
      );
    }
    return result.json?.data;
  }

  async function createOption(type, name, parentId, extra = {}) {
    const option = await api('/id-business-v2/options', {
      method: 'POST',
      body: JSON.stringify({
        type,
        name,
        parentId: parentId ?? null,
        remark: `Stage 7 API QA ${suffix}`,
        ...extra
      })
    });
    optionIds.push(option.id);
    objectIds.add(option.id);
    return option;
  }

  async function createOrder(input) {
    const created = await api('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    orderIds.push(created.order.id);
    objectIds.add(created.order.id);
    if (created.lock?.id) objectIds.add(created.lock.id);
    return created;
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
    for (const id of [...optionIds].reverse()) {
      await prisma.idBusinessV2Option.deleteMany({ where: { id } });
    }
  }

  try {
    const unauthorized = await request(
      '/id-business-v2/orders/00000000-0000-4000-8000-000000000000/refund',
      {
        method: 'POST',
        body: JSON.stringify({
          refundCostAmount: '1',
          reason: '未登录验收',
          idempotencyKey: `refund-${suffix}`
        })
      }
    );
    assert(
      unauthorized.response.status === 401,
      `未登录退款应返回 401，实际为 ${unauthorized.response.status}`
    );

    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assert(login?.accessToken, '管理员登录未返回 accessToken');
    token = login.accessToken;

    const statusSelectors = await api('/id-business-v2/options/selectors?type=id_status');
    const normalStatus = statusSelectors.items.find((item) => item.code === 'normal');
    assert(normalStatus, '缺少系统固定 ID 状态 normal');

    const countryAndRegionName = `Stage7 QA 美国 ${suffix}`;
    const country = await createOption('country', countryAndRegionName, null, {
      currencyCode: 'USD'
    });
    const category = await createOption('business_category', `Stage7 QA 分类 ${suffix}`);
    const service = await createOption('service', `Stage7 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const idSupplier = await createOption('id_supplier', `Stage7 QA ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `Stage7 QA 加卡供应商 ${suffix}`);
    const settlementPlatform = await createOption(
      'settlement_platform',
      `Stage7 QA 结算平台 ${suffix}`,
      null,
      { fixedFee: '1', percentageFee: '2' }
    );

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Stage7 QA 客户 ${suffix}`,
        serviceOptionIds: [service.id],
        sortOrder: 7,
        remark: 'Stage 7 真实事务验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);

    const websiteAccount = `stage7.customer.${suffix}@example.com`;
    const appleId = `stage7.qa.${suffix}@example.com`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `Stage7-${suffix}-Password!`,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: idSupplier.id,
        purchaseCost: '25',
        sortOrder: 7,
        remark: 'Stage 7 真实事务验收 ID'
      })
    });
    accountIds.push(account.id);
    objectIds.add(account.id);

    const giftCardCode = `V2507-${suffix}-CARD-3000`;
    const creditForm = new FormData();
    creditForm.set('code', giftCardCode);
    creditForm.set('faceValue', '30');
    creditForm.set('exchangeRate', '3');
    creditForm.set('supplierOptionId', topupSupplier.id);
    creditForm.set('idempotencyKey', `credit-${suffix}`);
    creditForm.set('remark', 'Stage 7 生命周期验收余额');
    const credit = await api(`/id-business-v2/gift-cards/${account.id}/credits`, {
      method: 'POST',
      body: creditForm
    });
    giftCardIds.push(credit.giftCard.id);
    objectIds.add(credit.giftCard.id);
    objectIds.add(credit.ledgerEntry.id);
    assertDecimal(credit.ledgerEntry.balanceAfter, '30', '初始入账后余额');
    assertDecimal(credit.ledgerEntry.costAfter, '90', '初始入账后余额成本');

    const openedAt = new Date();
    const firstDueAt = new Date(openedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const firstOrder = await createOrder({
      customerId: customer.id,
      serviceOptionId: service.id,
      accountId: account.id,
      settlementPlatformOptionId: settlementPlatform.id,
      platformOrderNo: `STAGE7-A-${suffix}`,
      websiteAccount,
      receivedAmount: '100',
      balanceAmount: '20',
      openedAt: openedAt.toISOString(),
      dueAt: firstDueAt.toISOString(),
      lockScope: 'by_service',
      idempotencyKey: `order-a-${suffix}`,
      sortOrder: 7,
      remark: 'Stage 7 待修改订单'
    });
    assert(firstOrder.order.status === 'pending', '第一笔订单没有进入 pending');

    const revisedDueAt = new Date(firstDueAt.getTime() + 24 * 60 * 60 * 1000);
    const pendingUpdated = await api(`/id-business-v2/orders/${firstOrder.order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        balanceAmount: '18',
        dueAt: revisedDueAt.toISOString(),
        remark: 'Stage 7 待处理修改已保存',
        expectedUpdatedAt: firstOrder.order.updatedAt
      })
    });
    assertDecimal(pendingUpdated.balanceAmount, '18', '待处理订单修改后消耗余额');
    assert(pendingUpdated.remark === 'Stage 7 待处理修改已保存', '待处理订单备注未修改');
    const firstLocks = await prisma.idBusinessV2AccountLock.findMany({
      where: { orderId: firstOrder.order.id },
      orderBy: { lockedAt: 'asc' }
    });
    firstLocks.forEach((item) => objectIds.add(item.id));
    assert(firstLocks.length === 2, '修改待处理订单没有释放旧锁并创建新锁');
    assert(firstLocks[0].status === 'released', '修改前的活动锁没有释放');
    assert(firstLocks[1].status === 'active', '修改后没有创建新的活动锁');

    const firstConsumed = await api(
      `/id-business-v2/orders/${firstOrder.order.id}/consume-balance`,
      {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: `consume-a-${suffix}` })
      }
    );
    objectIds.add(firstConsumed.ledgerEntry.id);
    assertDecimal(firstConsumed.ledgerEntry.balanceAfter, '12', '第一笔扣款后余额');
    assertDecimal(firstConsumed.ledgerEntry.costAfter, '36', '第一笔扣款后余额成本');
    assertDecimal(firstConsumed.order.balanceCostAmount, '54', '第一笔订单余额成本');

    const processingUpdated = await api(`/id-business-v2/orders/${firstOrder.order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        receivedAmount: '120',
        remark: 'Stage 7 已扣款财务修正',
        expectedUpdatedAt: firstConsumed.order.updatedAt
      })
    });
    assertDecimal(processingUpdated.platformFeeAmount, '3.4', '财务修正后平台手续费');
    assertDecimal(processingUpdated.profitAmount, '62.6', '财务修正后利润');
    assertDecimal(processingUpdated.balanceAmount, '18', '已扣款订单核心金额保持不变');

    const coreEditRejected = await request(`/id-business-v2/orders/${firstOrder.order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        balanceAmount: '17',
        expectedUpdatedAt: processingUpdated.updatedAt
      })
    });
    assert(
      coreEditRejected.response.status === 409,
      `已扣款订单修改核心字段应返回 409，实际为 ${coreEditRejected.response.status}`
    );

    const refundKey = `refund-a-${suffix}`;
    const refunded = await api(`/id-business-v2/orders/${firstOrder.order.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({
        refundCostAmount: '7',
        reason: 'Stage 7 默认不恢复余额退款',
        restoreBalance: false,
        idempotencyKey: refundKey
      })
    });
    assert(refunded.order.status === 'refunded', '第一笔订单没有进入 refunded');
    assert(refunded.balanceRestored === false, '默认退款错误恢复了 Apple 余额');
    assert(refunded.reversalLedger === null, '默认退款伪造了反向余额流水');
    assertDecimal(refunded.order.refundCostAmount, '7', '退款成本');
    assertDecimal(refunded.order.profitAmount, '55.6', '退款后利润');
    const afterRefundAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    assertDecimal(afterRefundAccount.currentBalance, '12', '默认退款后 ID 余额');
    assertDecimal(afterRefundAccount.balanceCostAmount, '36', '默认退款后 ID 余额成本');
    const firstReversalCount = await prisma.idBusinessV2BalanceLedger.count({
      where: {
        orderId: firstOrder.order.id,
        entryType: 'order_consumption_reversal'
      }
    });
    assert(firstReversalCount === 0, '默认退款写入了不真实的消费撤销流水');

    const refundReplay = await api(`/id-business-v2/orders/${firstOrder.order.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({
        refundCostAmount: '7',
        reason: 'Stage 7 默认不恢复余额退款',
        restoreBalance: false,
        idempotencyKey: refundKey
      })
    });
    assert(refundReplay.idempotentReplay === true, '相同退款请求没有幂等重放');

    const removed = await api(`/id-business-v2/orders/${firstOrder.order.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Stage 7 验证软删除保留账务证据' })
    });
    assert(removed.deleted === true, '软删除接口没有返回成功');
    const deletedRead = await request(`/id-business-v2/orders/${firstOrder.order.id}`);
    assert(
      deletedRead.response.status === 404,
      `软删除订单详情应返回 404，实际为 ${deletedRead.response.status}`
    );
    const deletedStoredOrder = await prisma.idBusinessV2Order.findUniqueOrThrow({
      where: { id: firstOrder.order.id }
    });
    assert(deletedStoredOrder.deletedAt, '数据库订单没有保存 deletedAt');
    const preservedConsumptionCount = await prisma.idBusinessV2BalanceLedger.count({
      where: {
        orderId: firstOrder.order.id,
        entryType: 'order_consumption'
      }
    });
    assert(preservedConsumptionCount === 1, '软删除破坏了原消费流水');

    const secondOpenedAt = new Date();
    const secondDueAt = new Date(secondOpenedAt.getTime() + 20 * 24 * 60 * 60 * 1000);
    const secondOrder = await createOrder({
      customerId: customer.id,
      serviceOptionId: service.id,
      accountId: account.id,
      settlementPlatformOptionId: settlementPlatform.id,
      platformOrderNo: `STAGE7-B-${suffix}`,
      receivedAmount: '50',
      balanceAmount: '5',
      openedAt: secondOpenedAt.toISOString(),
      dueAt: secondDueAt.toISOString(),
      lockScope: 'by_service',
      idempotencyKey: `order-b-${suffix}`,
      sortOrder: 8,
      remark: 'Stage 7 取消并恢复余额订单'
    });
    const secondConsumed = await api(
      `/id-business-v2/orders/${secondOrder.order.id}/consume-balance`,
      {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: `consume-b-${suffix}` })
      }
    );
    objectIds.add(secondConsumed.ledgerEntry.id);
    assertDecimal(secondConsumed.ledgerEntry.balanceAfter, '7', '第二笔扣款后余额');
    assertDecimal(secondConsumed.ledgerEntry.costAfter, '21', '第二笔扣款后余额成本');

    const cancelKey = `cancel-b-${suffix}`;
    const cancelled = await api(`/id-business-v2/orders/${secondOrder.order.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        reason: 'Stage 7 已确认未开通，撤销消费',
        idempotencyKey: cancelKey
      })
    });
    assert(cancelled.order.status === 'cancelled', '第二笔订单没有进入 cancelled');
    assert(cancelled.balanceRestored === true, '已扣款未开通订单没有恢复余额');
    assert(cancelled.reversalLedger, '取消订单没有返回真实反向流水');
    objectIds.add(cancelled.reversalLedger.id);
    assert(
      cancelled.reversalLedger.reversalOfEntryId === secondConsumed.ledgerEntry.id,
      '反向流水没有引用原消费流水'
    );
    assertDecimal(cancelled.reversalLedger.balanceAmount, '5', '反向流水恢复余额');
    assertDecimal(cancelled.reversalLedger.costAmount, '15', '反向流水恢复成本');
    const restoredAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    assertDecimal(restoredAccount.currentBalance, '12', '取消后恢复的 ID 余额');
    assertDecimal(restoredAccount.balanceCostAmount, '36', '取消后恢复的 ID 余额成本');

    const cancelReplay = await api(`/id-business-v2/orders/${secondOrder.order.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        reason: 'Stage 7 已确认未开通，撤销消费',
        idempotencyKey: cancelKey
      })
    });
    assert(cancelReplay.idempotentReplay === true, '相同取消请求没有幂等重放');
    assert(
      cancelReplay.reversalLedger.id === cancelled.reversalLedger.id,
      '取消幂等重放返回了不同反向流水'
    );
    const secondReversalCount = await prisma.idBusinessV2BalanceLedger.count({
      where: {
        orderId: secondOrder.order.id,
        entryType: 'order_consumption_reversal'
      }
    });
    assert(secondReversalCount === 1, '取消重试重复创建了反向流水');

    const changedCancel = await request(`/id-business-v2/orders/${secondOrder.order.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        reason: 'Stage 7 更换幂等键',
        idempotencyKey: `cancel-second-${suffix}`
      })
    });
    assert(
      changedCancel.response.status === 409,
      `更换幂等键重复取消应返回 409，实际为 ${changedCancel.response.status}`
    );

    const lifecycleAudits = await prisma.auditLog.findMany({
      where: {
        objectId: { in: orderIds }
      },
      select: {
        action: true,
        beforeData: true,
        afterData: true,
        remark: true
      }
    });
    const auditActions = new Set(lifecycleAudits.map((item) => item.action));
    assert(auditActions.has('id_business_v2.order.update'), '缺少订单修改审计');
    assert(auditActions.has('id_business_v2.order.refund'), '缺少订单退款审计');
    assert(auditActions.has('id_business_v2.order.cancel'), '缺少订单取消审计');
    assert(auditActions.has('id_business_v2.order.delete'), '缺少订单软删除审计');
    const auditJson = JSON.stringify(lifecycleAudits);
    assert(!auditJson.includes(websiteAccount), '生命周期审计泄露网站账号明文');
    assert(!auditJson.includes(refundKey), '生命周期审计泄露退款幂等键');
    assert(!auditJson.includes(cancelKey), '生命周期审计泄露取消幂等键');
    assert(!auditJson.includes(giftCardCode), '生命周期审计泄露礼品卡号');

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        unauthenticatedRejected: true,
        pendingUpdateRecreatedLock: true,
        consumedFinancialUpdateRecalculatedProfit: true,
        consumedCoreEditRejected: true,
        refundDidNotFakeBalanceRestoration: true,
        refundReplayWasIdempotent: true,
        softDeletePreservedLedger: true,
        cancellationRestoredExactOriginalMovement: true,
        cancellationReplayWasIdempotent: true,
        changedCancellationKeyRejected: true,
        lifecycleAuditsContainNoSecrets: true
      },
      amounts: {
        creditedBalance: '30',
        firstConsumptionBalance: '18',
        balanceAfterFirstConsumption: '12',
        costAfterFirstConsumption: '36',
        refundCost: '7',
        refundProfit: '55.6',
        secondConsumptionBalance: '5',
        balanceAfterCancellation: '12',
        costAfterCancellation: '36'
      },
      records: {
        customerId: customer.id,
        accountId: account.id,
        firstOrderId: firstOrder.order.id,
        secondOrderId: secondOrder.order.id,
        cancellationReversalId: cancelled.reversalLedger.id
      },
      cleanup: keepData ? 'kept_for_browser_verification' : 'completed'
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (!keepData || primaryError) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await prisma.$disconnect();
  }

  if (primaryError) throw primaryError;
  if (cleanupErrors.length) {
    throw new Error(`Stage 7 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`Stage 7 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
