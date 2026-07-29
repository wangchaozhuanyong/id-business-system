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
    // Missing files are reported later through the required configuration checks.
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
    process.env.V2_STAGE6_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE6_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE6_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const keepData = process.env.V2_STAGE6_ACCEPTANCE_KEEP_DATA === '1';

  assert(username && password, '缺少 Stage 6 验收管理员账号配置');
  assertLocalAcceptanceDatabase(apiBaseUrl, process.env.DATABASE_URL);

  const prisma = new PrismaClient();
  const suffix = `${Date.now()}`.slice(-10);
  const createdOptionIds = [];
  const objectIds = new Set();
  let token = '';
  let customerId = '';
  let accountId = '';
  let giftCardId = '';
  let orderId = '';
  let lockId = '';
  let consumptionLedgerId = '';
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
      // The error below keeps a short response excerpt without printing credentials.
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
        remark: `Stage 6 API QA ${suffix}`,
        ...extra
      })
    });
    createdOptionIds.push(option.id);
    objectIds.add(option.id);
    return option;
  }

  async function removeAcceptanceData() {
    const knownObjectIds = [
      ...objectIds,
      customerId,
      accountId,
      giftCardId,
      orderId,
      lockId,
      consumptionLedgerId
    ].filter(Boolean);

    if (knownObjectIds.length) {
      await prisma.sensitiveAccessLog.deleteMany({
        where: {
          objectId: {
            in: knownObjectIds
          }
        }
      });
      await prisma.auditLog.deleteMany({
        where: {
          objectId: {
            in: knownObjectIds
          }
        }
      });
    }

    if (accountId || orderId || giftCardId) {
      await prisma.idBusinessV2BalanceLedger.deleteMany({
        where: {
          OR: [
            ...(accountId ? [{ accountId }] : []),
            ...(orderId ? [{ orderId }] : []),
            ...(giftCardId ? [{ giftCardId }] : [])
          ]
        }
      });
    }
    if (orderId) {
      await prisma.idBusinessV2AccountLock.deleteMany({
        where: {
          orderId
        }
      });
      await prisma.idBusinessV2Order.deleteMany({
        where: {
          id: orderId
        }
      });
    }
    if (giftCardId) {
      await prisma.idBusinessV2GiftCard.deleteMany({
        where: {
          id: giftCardId
        }
      });
    }
    if (accountId) {
      await prisma.idBusinessV2Account.deleteMany({
        where: {
          id: accountId
        }
      });
    }
    if (customerId) {
      await prisma.idBusinessV2Customer.deleteMany({
        where: {
          id: customerId
        }
      });
    }
    for (const id of [...createdOptionIds].reverse()) {
      await prisma.idBusinessV2Option.deleteMany({
        where: {
          id
        }
      });
    }
  }

  try {
    const unauthorized = await request(
      '/id-business-v2/orders/00000000-0000-4000-8000-000000000000/consume-balance',
      {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: `consume-${suffix}` })
      }
    );
    assert(
      unauthorized.response.status === 401,
      `未登录扣款应返回 401，实际为 ${unauthorized.response.status}`
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

    const countryAndRegionName = `Stage6 QA 美国 ${suffix}`;
    const country = await createOption('country', countryAndRegionName, null, {
      currencyCode: 'USD'
    });
    const category = await createOption('business_category', `Stage6 QA 分类 ${suffix}`);
    const service = await createOption('service', `Stage6 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const idSupplier = await createOption('id_supplier', `Stage6 QA ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `Stage6 QA 加卡供应商 ${suffix}`);
    const settlementPlatform = await createOption(
      'settlement_platform',
      `Stage6 QA 结算平台 ${suffix}`,
      null,
      {
        fixedFee: '1',
        percentageFee: '2'
      }
    );

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Stage6 QA 客户 ${suffix}`,
        serviceOptionIds: [service.id],
        sortOrder: 6,
        remark: 'Stage 6 真实事务验收客户'
      })
    });
    customerId = customer.id;
    objectIds.add(customerId);

    const appleId = `stage6.qa.${suffix}@example.com`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `Stage6-${suffix}-Password!`,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: idSupplier.id,
        purchaseCost: '25',
        sortOrder: 6,
        remark: 'Stage 6 真实事务验收 ID'
      })
    });
    accountId = account.id;
    objectIds.add(accountId);
    assertDecimal(account.currentBalance, '0', '新 ID 初始余额');
    assertDecimal(account.balanceCostAmount, '0', '新 ID 初始余额成本');

    const giftCardCode = `V2506-${suffix}-CARD-3000`;
    const creditForm = new FormData();
    creditForm.set('code', giftCardCode);
    creditForm.set('faceValue', '30');
    creditForm.set('exchangeRate', '3');
    creditForm.set('supplierOptionId', topupSupplier.id);
    creditForm.set('idempotencyKey', `credit-${suffix}`);
    creditForm.set('remark', 'Stage 6 扣款前真实余额入账');
    const credit = await api(`/id-business-v2/gift-cards/${accountId}/credits`, {
      method: 'POST',
      body: creditForm
    });
    giftCardId = credit.giftCard.id;
    objectIds.add(giftCardId);
    objectIds.add(credit.ledgerEntry.id);
    assertDecimal(credit.ledgerEntry.balanceAfter, '30', '加卡后余额');
    assertDecimal(credit.ledgerEntry.costAfter, '90', '加卡后人民币成本');
    assert(!JSON.stringify(credit).includes(giftCardCode), '加卡响应泄露完整礼品卡号');

    const candidates = await api(
      `/id-business-v2/orders/matching-candidates?serviceOptionId=${
        service.id
      }&balanceAmount=20&limit=20`
    );
    assert(candidates.selectedCandidateId === accountId, '自动匹配没有选中同国家可用 ID');
    assert(
      candidates.items.some((item) => item.id === accountId),
      '候选列表缺少验收 ID'
    );

    const openedAt = new Date();
    const dueAt = new Date(openedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const websiteAccount = `customer.${suffix}@example.com`;
    const orderCreated = await api('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        serviceOptionId: service.id,
        accountId,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `STAGE6-${suffix}`,
        websiteAccount,
        receivedAmount: '100',
        balanceAmount: '20',
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        lockScope: 'by_service',
        idempotencyKey: `order-${suffix}`,
        sortOrder: 6,
        remark: 'Stage 6 真实扣款订单'
      })
    });
    orderId = orderCreated.order.id;
    lockId = orderCreated.lock.id;
    objectIds.add(orderId);
    objectIds.add(lockId);
    assert(orderCreated.order.status === 'pending', '新订单没有保持 pending');
    assert(orderCreated.lock.status === 'active', '订单没有取得活动锁');
    assertDecimal(orderCreated.order.platformFeeAmount, '3', '服务端平台手续费');
    assert(orderCreated.nextStep === 'waiting_balance_consumption', '订单创建下一步不正确');
    assert(!JSON.stringify(orderCreated).includes(websiteAccount), '订单响应泄露网站账号明文');

    const consumptionKey = `consume-${suffix}`;
    const consumed = await api(`/id-business-v2/orders/${orderId}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: consumptionKey
      })
    });
    consumptionLedgerId = consumed.ledgerEntry.id;
    objectIds.add(consumptionLedgerId);
    assert(consumed.idempotentReplay === false, '首次扣款被错误标记为幂等重放');
    assert(consumed.order.status === 'processing', '扣款后订单没有进入 processing');
    assert(consumed.nextStep === 'waiting_activation_record', '扣款后下一步不正确');
    assertDecimal(consumed.order.platformFeeAmount, '3', '扣款订单平台手续费');
    assertDecimal(consumed.order.accountCostAmount, '25', 'ID 成本快照');
    assertDecimal(consumed.order.balanceCostAmount, '60', '本次余额成本');
    assertDecimal(consumed.order.profitAmount, '37', '服务端订单利润');
    assertDecimal(consumed.ledgerEntry.balanceBefore, '30', '扣款前余额');
    assertDecimal(consumed.ledgerEntry.balanceAfter, '10', '扣款后余额');
    assertDecimal(consumed.ledgerEntry.costBefore, '90', '扣款前余额成本');
    assertDecimal(consumed.ledgerEntry.costAfter, '30', '扣款后余额成本');
    assertDecimal(consumed.ledgerEntry.averageCostBefore, '3', '扣款前移动平均成本');
    assertDecimal(consumed.ledgerEntry.averageCostAfter, '3', '扣款后移动平均成本');

    const storedAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: {
        id: accountId
      }
    });
    assertDecimal(storedAccount.currentBalance, '10', '数据库 ID 当前余额');
    assertDecimal(storedAccount.balanceCostAmount, '30', '数据库 ID 余额人民币成本');

    const storedOrder = await prisma.idBusinessV2Order.findUniqueOrThrow({
      where: {
        id: orderId
      }
    });
    assert(storedOrder.status === 'processing', '数据库订单状态不是 processing');
    assertDecimal(storedOrder.platformFeeAmount, '3', '数据库平台手续费');
    assertDecimal(storedOrder.accountCostAmount, '25', '数据库 ID 成本快照');
    assertDecimal(storedOrder.balanceCostAmount, '60', '数据库余额成本');
    assertDecimal(storedOrder.profitAmount, '37', '数据库利润');

    const consumptionEntries = await prisma.idBusinessV2BalanceLedger.findMany({
      where: {
        orderId,
        entryType: 'order_consumption'
      }
    });
    assert(consumptionEntries.length === 1, '订单没有且仅有一条扣款流水');
    const [consumptionEntry] = consumptionEntries;
    assert(consumptionEntry.direction === 'debit', '订单消费流水方向不是 debit');
    assertDecimal(consumptionEntry.balanceAmount, '20', '数据库扣款余额');
    assertDecimal(consumptionEntry.costAmount, '60', '数据库扣款成本');
    assertDecimal(consumptionEntry.balanceBefore, '30', '数据库扣款前余额');
    assertDecimal(consumptionEntry.balanceAfter, '10', '数据库扣款后余额');

    const replay = await api(`/id-business-v2/orders/${orderId}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: consumptionKey
      })
    });
    assert(replay.idempotentReplay === true, '相同幂等键没有返回幂等重放');
    assert(replay.ledgerEntry.id === consumptionLedgerId, '幂等重放返回了不同流水');

    const postReplayAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: {
        id: accountId
      }
    });
    const postReplayLedgerCount = await prisma.idBusinessV2BalanceLedger.count({
      where: {
        orderId,
        entryType: 'order_consumption'
      }
    });
    assertDecimal(postReplayAccount.currentBalance, '10', '幂等重放后余额');
    assertDecimal(postReplayAccount.balanceCostAmount, '30', '幂等重放后余额成本');
    assert(postReplayLedgerCount === 1, '幂等重放重复创建了扣款流水');

    const duplicateDebit = await request(`/id-business-v2/orders/${orderId}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `consume-second-${suffix}`
      })
    });
    assert(
      duplicateDebit.response.status === 409,
      `更换幂等键重复扣款应返回 409，实际为 ${duplicateDebit.response.status}`
    );

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        OR: [
          {
            objectId: orderId
          },
          {
            objectId: lockId
          }
        ]
      },
      select: {
        action: true,
        beforeData: true,
        afterData: true
      }
    });
    const auditActions = new Set(auditLogs.map((item) => item.action));
    assert(auditActions.has('id_business_v2.order.consume_balance'), '缺少订单余额扣减审计日志');
    const auditJson = JSON.stringify(auditLogs);
    assert(!auditJson.includes(websiteAccount), '扣款审计日志泄露网站账号');
    assert(!auditJson.includes(giftCardCode), '扣款审计日志泄露礼品卡号');
    assert(!auditJson.includes(consumptionKey), '扣款审计日志泄露内部幂等键');

    const list = await api(
      `/id-business-v2/orders?page=1&pageSize=20&keyword=${encodeURIComponent(
        orderCreated.order.orderNo
      )}&status=processing`
    );
    assert(list.total === 1 && list.items[0]?.id === orderId, '订单列表没有返回真实扣款结果');

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        unauthenticatedRejected: true,
        realCreditTransaction: true,
        realOrderAndLockTransaction: true,
        realBalanceDebit: true,
        immutableLedger: true,
        serverSideProfit: true,
        idempotentReplay: true,
        duplicateDebitRejected: true,
        auditWithoutSecrets: true,
        orderListPersistence: true
      },
      amounts: {
        balanceBefore: '30',
        balanceAfter: '10',
        costBefore: '90',
        costAfter: '30',
        platformFee: '3',
        balanceCost: '60',
        profit: '37'
      },
      records: {
        customerId,
        accountId,
        giftCardId,
        orderId,
        lockId,
        consumptionLedgerId
      },
      cleanup: keepData ? 'kept_for_browser_verification' : 'completed'
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (!keepData || primaryError) {
      try {
        await removeAcceptanceData();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await prisma.$disconnect();
  }

  if (primaryError) {
    throw primaryError;
  }
  if (cleanupErrors.length) {
    throw new Error(`Stage 6 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }

  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`Stage 6 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
