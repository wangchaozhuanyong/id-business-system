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
    process.env.V2_STAGE2603_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE2603_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE2603_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const keepData = process.env.V2_STAGE2603_ACCEPTANCE_KEEP_DATA === '1';

  assert(username && password, '缺少 V2603 验收管理员账号配置');
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
        remark: `V2603 API QA ${suffix}`,
        ...extra
      })
    });
    optionIds.push(option.id);
    objectIds.add(option.id);
    return option;
  }

  async function creditGiftCard(accountId, payload) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      form.set(key, value);
    }
    return api(`/id-business-v2/gift-cards/${accountId}/credits`, {
      method: 'POST',
      body: form
    });
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
      '/id-business-v2/renewals/11111111-1111-4111-8111-111111111111/topup-credit',
      {
        method: 'POST',
        body: JSON.stringify({})
      }
    );
    assert(
      unauthorized.response.status === 401,
      `未登录续费充值应返回 401，实际为 ${unauthorized.response.status}`
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

    const locationName = `V2603 QA 美国 ${suffix}`;
    const country = await createOption('country', locationName, null, { currencyCode: 'USD' });
    const category = await createOption('business_category', `V2603 QA 分类 ${suffix}`);
    const service = await createOption('service', `V2603 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const idSupplier = await createOption('id_supplier', `V2603 QA ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `V2603 QA 加卡供应商 ${suffix}`);

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `V2603 QA 客户 ${suffix}`,
        serviceOptionIds: [service.id],
        sortOrder: 26,
        remark: 'V2603 续费充值真实验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);

    const websiteAccount = `v2603.customer.${suffix}@example.com`;
    const appleId = `v2603.qa.${suffix}@example.com`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `V2603-${suffix}-Password!`,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: idSupplier.id,
        purchaseCost: '20',
        sortOrder: 26,
        remark: 'V2603 续费充值真实验收 ID'
      })
    });
    accountIds.push(account.id);
    objectIds.add(account.id);

    const initialGiftCardCode = `V2603${suffix}INITIAL20`;
    const initialCredit = await creditGiftCard(account.id, {
      code: initialGiftCardCode,
      faceValue: '20',
      exchangeRate: '3',
      supplierOptionId: topupSupplier.id,
      idempotencyKey: `initial-credit-${suffix}`,
      remark: 'V2603 建立续费前余额'
    });
    giftCardIds.push(initialCredit.giftCard.id);
    objectIds.add(initialCredit.giftCard.id);
    objectIds.add(initialCredit.ledgerEntry.id);

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
        sortOrder: 26,
        remark: 'V2603 续费充值真实验收订单'
      })
    });
    orderIds.push(created.order.id);
    objectIds.add(created.order.id);
    if (created.lock?.id) objectIds.add(created.lock.id);

    const consumed = await api(`/id-business-v2/orders/${created.order.id}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `consume-${suffix}` })
    });
    objectIds.add(consumed.ledgerEntry.id);

    const completed = await api(`/id-business-v2/orders/${created.order.id}/complete`, {
      method: 'POST'
    });
    objectIds.add(completed.activation.id);

    const beforeTopup = await api(
      `/id-business-v2/renewals/workbench?keyword=${encodeURIComponent(created.order.orderNo)}`
    );
    assert(beforeTopup.total === 1, '续费充值前没有找到真实到期记录');
    assert(beforeTopup.items[0].account.currentBalance === '10', '订单扣款后的续费余额应为 10');

    const renewalGiftCardCode = `V2603${suffix}RENEW15`;
    const topupPayload = {
      code: renewalGiftCardCode,
      faceValue: '15',
      exchangeRate: '4',
      supplierOptionId: topupSupplier.id,
      idempotencyKey: `renewal-topup-${suffix}`,
      remark: '操作员已核对礼品卡资料'
    };
    const topup = await api(`/id-business-v2/renewals/${completed.activation.id}/topup-credit`, {
      method: 'POST',
      body: JSON.stringify(topupPayload)
    });
    giftCardIds.push(topup.giftCard.id);
    objectIds.add(topup.giftCard.id);
    objectIds.add(topup.ledgerEntry.id);

    assert(topup.ledgerEntry.balanceBefore === '10', '续费充值前余额快照不正确');
    assert(topup.ledgerEntry.balanceAfter === '25', '续费充值没有真实增加余额');
    assert(topup.ledgerEntry.costBefore === '30', '续费充值前成本快照不正确');
    assert(topup.ledgerEntry.costAfter === '90', '续费充值没有按汇率增加成本');
    assert(topup.account.currentBalance === '25', '续费充值返回的当前余额不正确');
    assert(topup.account.balanceCostAmount === '90', '续费充值返回的当前成本不正确');
    assert(topup.renewal.activationId === completed.activation.id, '续费充值上下文错误');
    assert(topup.executionBoundary.systemLedgerCredited === true, '系统余额入账边界缺失');
    assert(
      topup.executionBoundary.appleOfficialTopupExecuted === false,
      '续费充值错误宣称已执行 Apple 官网动作'
    );
    assert(topup.executionBoundary.appleWorkerRequired === true, '续费充值缺少 Worker 边界');

    const replay = await api(`/id-business-v2/renewals/${completed.activation.id}/topup-credit`, {
      method: 'POST',
      body: JSON.stringify(topupPayload)
    });
    assert(replay.idempotentReplay === true, '相同续费充值请求没有幂等重放');
    assert(replay.account.currentBalance === '25', '幂等重放重复增加了余额');

    const duplicateCode = await request(
      `/id-business-v2/renewals/${completed.activation.id}/topup-credit`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...topupPayload,
          idempotencyKey: `duplicate-code-${suffix}`
        })
      }
    );
    assert(
      duplicateCode.response.status === 409,
      `重复礼品卡应返回 409，实际为 ${duplicateCode.response.status}`
    );

    const malformedActivation = await request('/id-business-v2/renewals/not-a-uuid/topup-credit', {
      method: 'POST',
      body: JSON.stringify(topupPayload)
    });
    assert(
      malformedActivation.response.status === 400,
      `非法续费记录应返回 400，实际为 ${malformedActivation.response.status}`
    );

    const afterTopup = await api(
      `/id-business-v2/renewals/workbench?keyword=${encodeURIComponent(created.order.orderNo)}`
    );
    assert(afterTopup.items[0].account.currentBalance === '25', '续费列表没有刷新真实余额');

    const ledgerEntries = await prisma.idBusinessV2BalanceLedger.findMany({
      where: {
        accountId: account.id,
        entryType: 'gift_card_credit'
      },
      orderBy: { createdAt: 'asc' }
    });
    assert(ledgerEntries.length === 2, '续费充值没有且仅没有生成一笔新的礼品卡流水');
    assert(
      ledgerEntries[1].remark?.includes(completed.activation.id),
      '续费充值流水没有关联续费记录'
    );
    assert(ledgerEntries[1].remark?.includes(created.order.orderNo), '续费充值流水没有关联订单号');

    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'id_business_v2.gift_card.credit',
        objectId: topup.giftCard.id
      }
    });
    assert(audits.length === 1, '续费充值缺少唯一审计记录');
    const auditJson = JSON.stringify(audits);
    assert(auditJson.includes(completed.activation.id), '续费充值审计缺少续费上下文');
    assert(!auditJson.includes(renewalGiftCardCode), '续费充值审计泄露礼品卡明文');

    const responseJson = JSON.stringify({ topup, replay, afterTopup });
    assert(!responseJson.includes(renewalGiftCardCode), '续费充值响应泄露礼品卡明文');
    assert(!responseJson.includes(initialGiftCardCode), '续费充值响应泄露初始礼品卡明文');
    assert(!responseJson.includes(websiteAccount), '续费充值响应泄露网站账号明文');
    assert(!responseJson.includes(appleId), '续费充值响应泄露 Apple ID 明文');

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        unauthenticatedRejected: true,
        actionableRenewalRequired: true,
        realGiftCardTransactionUsed: true,
        decimalBalanceChangedFrom10To25: true,
        decimalCostChangedFrom30To90: true,
        idempotentReplayDidNotDoubleCredit: true,
        duplicateGiftCardRejected: true,
        renewalListReturnedUpdatedBalance: true,
        auditContextIsLinkedAndRedacted: true,
        appleOfficialExecutionRemainsFalse: true,
        cleanupIsDeterministic: true
      },
      records: {
        customerId: customer.id,
        accountId: account.id,
        orderId: created.order.id,
        activationId: completed.activation.id,
        giftCardId: topup.giftCard.id,
        ledgerEntryId: topup.ledgerEntry.id
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
    throw new Error(`V2603 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`V2603 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
