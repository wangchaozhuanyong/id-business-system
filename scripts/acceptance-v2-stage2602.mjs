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
    process.env.V2_STAGE2602_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE2602_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE2602_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const keepData = process.env.V2_STAGE2602_ACCEPTANCE_KEEP_DATA === '1';

  assert(username && password, '缺少 V2602 验收管理员账号配置');
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
        remark: `V2602 API QA ${suffix}`,
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
    const unauthorized = await request('/id-business-v2/renewals/workbench');
    assert(
      unauthorized.response.status === 401,
      `未登录续费工作台应返回 401，实际为 ${unauthorized.response.status}`
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

    const locationName = `V2602 QA 美国 ${suffix}`;
    const country = await createOption('country', locationName, null, { currencyCode: 'USD' });
    const category = await createOption('business_category', `V2602 QA 分类 ${suffix}`);
    const service = await createOption('service', `V2602 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const idSupplier = await createOption('id_supplier', `V2602 QA ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `V2602 QA 加卡供应商 ${suffix}`);

    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `V2602 QA 客户 ${suffix}`,
        serviceOptionIds: [service.id],
        sortOrder: 26,
        remark: 'V2602 真实续费列表验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);

    const websiteAccount = `v2602.customer.${suffix}@example.com`;
    const appleId = `v2602.qa.${suffix}@example.com`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `V2602-${suffix}-Password!`,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: idSupplier.id,
        purchaseCost: '20',
        sortOrder: 26,
        remark: 'V2602 真实续费列表验收 ID'
      })
    });
    accountIds.push(account.id);
    objectIds.add(account.id);

    const giftCardCode = `V2602-${suffix}-CARD-3000`;
    const creditForm = new FormData();
    creditForm.set('code', giftCardCode);
    creditForm.set('faceValue', '30');
    creditForm.set('exchangeRate', '3');
    creditForm.set('supplierOptionId', topupSupplier.id);
    creditForm.set('idempotencyKey', `credit-${suffix}`);
    creditForm.set('remark', 'V2602 续费工作台验收余额');
    const credit = await api(`/id-business-v2/gift-cards/${account.id}/credits`, {
      method: 'POST',
      body: creditForm
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
        sortOrder: 26,
        remark: 'V2602 真实续费列表验收订单'
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

    const defaultList = await api(
      `/id-business-v2/renewals/workbench?keyword=${encodeURIComponent(
        created.order.orderNo
      )}&page=1&pageSize=20`
    );
    assert(defaultList.total === 1, '默认续费工作台没有返回 7 天内真实开通记录');
    assert(defaultList.items[0].id === completed.activation.id, '续费工作台返回了错误记录');
    assert(
      defaultList.items[0].status.code === 'due_within_7_days',
      '续费工作台服务端到期状态不正确'
    );
    assert(defaultList.items[0].account.currentBalance === '20', '续费工作台余额不是实时余额');

    const sevenDayList = await api(
      `/id-business-v2/renewals/workbench?dueStatus=due_within_7_days&customerId=${
        customer.id
      }&serviceOptionId=${service.id}&accountId=${account.id}&page=1&pageSize=20`
    );
    assert(sevenDayList.total === 1, '续费工作台关系筛选没有返回真实记录');

    const shorterWindow = await api(
      `/id-business-v2/renewals/workbench?dueStatus=due_within_23_hours&accountId=${account.id}`
    );
    assert(shorterWindow.total === 0, '23 小时筛选错误包含了 4 天后到期记录');

    const filterOptions = await api('/id-business-v2/renewals/workbench/filter-options');
    assert(
      filterOptions.customers.some((item) => item.id === customer.id),
      '续费客户筛选选项缺少真实客户'
    );
    assert(
      filterOptions.accounts.some((item) => item.id === account.id),
      '续费 ID 筛选选项缺少真实 ID'
    );
    assert(
      filterOptions.services.some((item) => item.id === service.id),
      '续费业务筛选选项缺少真实业务'
    );

    const invalidStatus = await request('/id-business-v2/renewals/workbench?dueStatus=active');
    assert(
      invalidStatus.response.status === 400,
      `续费工作台不支持的状态应返回 400，实际为 ${invalidStatus.response.status}`
    );

    const responseJson = JSON.stringify({ defaultList, sevenDayList, filterOptions });
    assert(!responseJson.includes(websiteAccount), '续费工作台泄露网站账号明文');
    assert(!responseJson.includes(appleId), '续费工作台泄露 Apple ID 明文');
    assert(!responseJson.includes(giftCardCode), '续费工作台泄露礼品卡号');

    resultSummary = {
      ok: true,
      suffix,
      checks: {
        unauthenticatedRejected: true,
        realActivationAppearsInDefaultWorkbench: true,
        currentDecimalBalanceReturned: true,
        serverDueStatusReturned: true,
        relationFiltersUseRealData: true,
        dueWindowsDoNotOverlap: true,
        filterOptionsUseActionableRecords: true,
        unsupportedStatusRejected: true,
        responsesContainNoSecrets: true,
        cleanupIsDeterministic: true
      },
      records: {
        customerId: customer.id,
        accountId: account.id,
        orderId: created.order.id,
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
    throw new Error(`V2602 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`V2602 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
