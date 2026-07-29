#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
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
    // Required configuration is reported below.
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE8_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE8_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE8_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const keepData = process.env.V2_STAGE8_ACCEPTANCE_KEEP_DATA === '1';

  assert(username && password, '缺少 Stage 8 验收管理员账号配置');
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
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // The caller receives a short non-sensitive body excerpt.
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
        remark: `Stage 8 API QA ${suffix}`,
        ...extra
      })
    });
    optionIds.push(option.id);
    objectIds.add(option.id);
    return option;
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
      '/id-business-v2/orders/00000000-0000-4000-8000-000000000000/complete',
      {
        method: 'POST'
      }
    );
    assert(
      unauthorized.response.status === 401,
      `未登录确认开通应返回 401，实际为 ${unauthorized.response.status}`
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

    const locationName = `Stage8 QA 美国 ${suffix}`;
    const country = await createOption('country', locationName, null, { currencyCode: 'USD' });
    const category = await createOption('business_category', `Stage8 QA 分类 ${suffix}`);
    const service = await createOption('service', `Stage8 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const idSupplier = await createOption('id_supplier', `Stage8 QA ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `Stage8 QA 加卡供应商 ${suffix}`);

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Stage8 QA 客户 ${suffix}`,
        serviceOptionIds: [service.id],
        sortOrder: 8,
        remark: 'Stage 8 真实开通验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);

    const websiteAccount = `stage8.customer.${suffix}@example.com`;
    const appleId = `stage8.qa.${suffix}@example.com`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `Stage8-${suffix}-Password!`,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: idSupplier.id,
        purchaseCost: '25',
        sortOrder: 8,
        remark: 'Stage 8 真实开通验收 ID'
      })
    });
    accountIds.push(account.id);
    objectIds.add(account.id);

    const giftCardCode = `V2508-${suffix}-CARD-3000`;
    const credit = await api(`/id-business-v2/gift-cards/${account.id}/credits`, {
      method: 'POST',
      body: JSON.stringify({
        code: giftCardCode,
        faceValue: '30',
        exchangeRate: '3',
        supplierOptionId: topupSupplier.id,
        idempotencyKey: `credit-${suffix}`,
        remark: 'Stage 8 开通记录验收余额'
      })
    });
    giftCardIds.push(credit.giftCard.id);
    objectIds.add(credit.giftCard.id);
    objectIds.add(credit.ledgerEntry.id);

    const openedAt = new Date();
    const dueAt = new Date(openedAt.getTime() + 4 * 24 * 60 * 60 * 1000);
    const created = await api('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        serviceOptionId: service.id,
        accountId: account.id,
        websiteAccount,
        receivedAmount: '70',
        balanceAmount: '10',
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        lockScope: 'by_service',
        idempotencyKey: `order-${suffix}`,
        sortOrder: 8,
        remark: 'Stage 8 真实开通记录'
      })
    });
    orderIds.push(created.order.id);
    objectIds.add(created.order.id);
    if (created.lock?.id) objectIds.add(created.lock.id);
    assert(created.order.status === 'pending', '订单没有先进入 pending');

    const missingConsumption = await request(
      `/id-business-v2/orders/${created.order.id}/complete`,
      {
        method: 'POST'
      }
    );
    assert(
      missingConsumption.response.status === 409,
      `未扣款订单确认开通应返回 409，实际为 ${missingConsumption.response.status}`
    );
    const activationCountBeforeConsumption = await prisma.idBusinessV2Activation.count({
      where: { orderId: created.order.id }
    });
    assert(activationCountBeforeConsumption === 0, '未扣款订单错误生成了开通记录');

    const consumed = await api(`/id-business-v2/orders/${created.order.id}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `consume-${suffix}` })
    });
    objectIds.add(consumed.ledgerEntry.id);
    assert(consumed.order.status === 'processing', '真实扣款后订单没有进入 processing');

    const completed = await api(`/id-business-v2/orders/${created.order.id}/complete`, {
      method: 'POST'
    });
    objectIds.add(completed.activation.id);
    assert(completed.order.status === 'completed', '确认开通后订单没有进入 completed');
    assert(completed.activation.status === 'active', '生成的开通记录状态不是 active');
    assert(
      completed.consumptionLedgerId === consumed.ledgerEntry.id,
      '完成响应没有引用原始扣款流水'
    );

    const storedOrder = await prisma.idBusinessV2Order.findUniqueOrThrow({
      where: { id: created.order.id }
    });
    const storedActivation = await prisma.idBusinessV2Activation.findUniqueOrThrow({
      where: { orderId: created.order.id }
    });
    assert(storedOrder.status === 'completed', '数据库订单状态不是 completed');
    assert(storedActivation.accountId === account.id, '开通记录没有绑定真实扣款 ID');
    assert(storedActivation.customerId === customer.id, '开通记录没有绑定订单客户');
    assert(storedActivation.serviceOptionId === service.id, '开通记录没有绑定订单业务');
    assert(storedActivation.openedAt.getTime() === openedAt.getTime(), '开通时间与订单不一致');
    assert(storedActivation.dueAt?.getTime() === dueAt.getTime(), '到期时间与订单不一致');

    const replay = await api(`/id-business-v2/orders/${created.order.id}/complete`, {
      method: 'POST'
    });
    assert(replay.idempotentReplay === true, '重复确认开通没有幂等返回');
    assert(replay.activation.id === completed.activation.id, '重复确认返回了不同开通记录');
    const activationCountAfterReplay = await prisma.idBusinessV2Activation.count({
      where: { orderId: created.order.id }
    });
    assert(activationCountAfterReplay === 1, '重复确认创建了多条开通记录');

    const list = await api(
      `/id-business-v2/activations?keyword=${encodeURIComponent(
        created.order.orderNo
      )}&dueStatus=due_within_7_days&page=1&pageSize=20`
    );
    assert(list.total === 1, '开通记录列表没有返回刚完成的真实订单');
    assert(list.items[0].id === completed.activation.id, '列表返回了错误的开通记录');
    assert(list.items[0].status.code === 'due_within_7_days', '服务端到期状态计算不正确');
    assert(list.items[0].maskedWebsiteAccount, '列表没有返回脱敏网站账号');
    assert(!JSON.stringify(list).includes(websiteAccount), '列表泄露网站账号明文');
    assert(!JSON.stringify(list).includes(appleId), '列表泄露 Apple ID 明文');

    const detail = await api(`/id-business-v2/activations/${completed.activation.id}`);
    assert(detail.order.orderNo === created.order.orderNo, '开通记录详情订单不一致');
    assert(detail.account.appleIdMasked === account.appleIdMasked, '详情脱敏 Apple ID 不一致');

    const completionAudits = await prisma.auditLog.findMany({
      where: {
        objectId: created.order.id,
        action: 'id_business_v2.order.complete'
      },
      select: {
        beforeData: true,
        afterData: true,
        remark: true
      }
    });
    assert(completionAudits.length === 1, '订单完成没有且仅有一条审计记录');
    const auditJson = JSON.stringify(completionAudits);
    assert(!auditJson.includes(websiteAccount), '订单完成审计泄露网站账号明文');
    assert(!auditJson.includes(appleId), '订单完成审计泄露 Apple ID 明文');
    assert(!auditJson.includes(giftCardCode), '订单完成审计泄露礼品卡号');

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        unauthenticatedRejected: true,
        missingConsumptionRejectedWithoutActivation: true,
        realConsumptionRequired: true,
        completionCreatedActivationAtomically: true,
        completionReferencedImmutableLedger: true,
        completionReplayWasIdempotent: true,
        oneOrderHasOneActivation: true,
        dueStatusCalculatedOnServer: true,
        listAndDetailUseRealMaskedData: true,
        completionAuditContainsNoSecrets: true
      },
      records: {
        customerId: customer.id,
        accountId: account.id,
        orderId: created.order.id,
        consumptionLedgerId: consumed.ledgerEntry.id,
        activationId: completed.activation.id
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
    throw new Error(`Stage 8 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`Stage 8 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
