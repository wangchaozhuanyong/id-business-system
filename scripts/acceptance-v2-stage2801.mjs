#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertLocalAcceptanceDatabase } from './lib/development-data-cleanup.mjs';

const DEFAULT_API_BASE_URL = 'http://localhost:3000/api';
const EXCHANGE_WAIT_TIMEOUT_MS = 120_000;

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

function assertDecimal(actual, expected, label) {
  assert.equal(
    new Prisma.Decimal(actual).toString(),
    new Prisma.Decimal(expected).toString(),
    `${label}不一致`
  );
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE2801_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE2801_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE2801_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;
  const keepData = process.env.V2_STAGE2801_ACCEPTANCE_KEEP_DATA === '1';
  const acceptanceDatabasePath = new URL(databaseUrl ?? 'http://localhost').pathname.toLowerCase();

  assert.ok(username && password, '缺少 V2801 验收管理员账号配置');
  assert.ok(databaseUrl, '缺少 V2801 验收 DATABASE_URL');
  assertLocalAcceptanceDatabase(apiBaseUrl, databaseUrl);
  assert.ok(
    ['/v2801_acceptance', '/v2805_acceptance'].includes(acceptanceDatabasePath),
    'V2801 只能在 v2801_acceptance 或 V2805 专用一次性数据库运行'
  );
  assert.ok(
    acceptanceDatabasePath !== '/v2805_acceptance' || keepData,
    '复用 V2801 夹具到 V2805 数据库时必须保留数据供生产页面回归'
  );

  const prisma = new PrismaClient();
  const suffix = `${Date.now()}`.slice(-10);
  const optionIds = [];
  const customerIds = [];
  const accountIds = [];
  const giftCardIds = [];
  const orderIds = [];
  const supplierAccountIds = [];
  const objectIds = new Set();
  let token = '';
  let primaryError = null;
  let resultSummary = null;
  const cleanupErrors = [];

  async function request(path, options = {}) {
    const { tokenOverride, ...fetchOptions } = options;
    const requestToken = tokenOverride === undefined ? token : tokenOverride;
    const isFormData = fetchOptions.body instanceof FormData;
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        ...(!isFormData ? { 'content-type': 'application/json' } : {}),
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

  async function createOption(type, name, parentId = null, extra = {}) {
    const option = await api('/id-business-v2/options', {
      method: 'POST',
      body: JSON.stringify({
        type,
        name,
        parentId,
        remark: `V2801 Excel API QA ${suffix}`,
        ...extra
      })
    });
    optionIds.push(option.id);
    objectIds.add(option.id);
    return option;
  }

  async function createAccount({
    appleId,
    countryOptionId,
    statusOptionId,
    supplierOptionId,
    phone,
    securityInfo,
    sortOrder
  }) {
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: `V2801-${suffix}-${sortOrder}-Password!`,
        phone,
        securityInfo,
        countryOptionId,
        statusOptionId,
        supplierOptionId,
        purchaseCost: '25',
        sortOrder,
        remark: 'V2801 Excel 验收 ID'
      })
    });
    accountIds.push(account.id);
    objectIds.add(account.id);
    return account;
  }

  async function creditAccount(accountId, supplierOptionId, marker, faceValue) {
    const code = `V2801-${suffix}-${marker}-CARD`;
    const credit = await api(`/id-business-v2/gift-cards/${accountId}/credits`, {
      method: 'POST',
      body: JSON.stringify({
        code,
        faceValue,
        exchangeRate: '3',
        supplierOptionId,
        idempotencyKey: `v2801-credit-${suffix}-${marker}`,
        remark: `V2801 ${marker} 加卡`
      })
    });
    giftCardIds.push(credit.giftCard.id);
    objectIds.add(credit.giftCard.id);
    objectIds.add(credit.ledgerEntry.id);
    assert.equal(JSON.stringify(credit).includes(code), false, '加卡响应泄露完整礼品卡号');
    return { credit, code };
  }

  async function waitForExchangeIdle() {
    const deadline = Date.now() + EXCHANGE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const overview = await api('/id-business-v2/exchange-rates/overview');
      if (overview.latestRun?.status !== 'running') return overview;
      await sleep(500);
    }
    throw new Error('汇率采集运行超过 120 秒，未进入可验收状态');
  }

  async function cleanup() {
    await prisma.$transaction(async (cleanupTx) => {
      await cleanupTx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      const knownObjectIds = [...objectIds, ...supplierAccountIds].filter(Boolean);
      const financeJournals = knownObjectIds.length
        ? await cleanupTx.idBusinessV2FinanceJournal.findMany({
            where: { sourceId: { in: knownObjectIds } },
            select: { id: true }
          })
        : [];
      const financeJournalIds = financeJournals.map((journal) => journal.id);
      const allAuditObjectIds = [...knownObjectIds, ...financeJournalIds];
      if (allAuditObjectIds.length) {
        await cleanupTx.sensitiveAccessLog.deleteMany({
          where: { objectId: { in: allAuditObjectIds } }
        });
        await cleanupTx.auditLog.deleteMany({
          where: { objectId: { in: allAuditObjectIds } }
        });
      }
      if (financeJournalIds.length) {
        await cleanupTx.idBusinessV2FinanceJournalLine.deleteMany({
          where: { journalId: { in: financeJournalIds } }
        });
        await cleanupTx.idBusinessV2FinanceJournal.deleteMany({
          where: { id: { in: financeJournalIds } }
        });
      }
      if (giftCardIds.length || supplierAccountIds.length) {
        await cleanupTx.idBusinessV2TopupSupplierLedger.deleteMany({
          where: {
            OR: [
              ...(giftCardIds.length ? [{ giftCardId: { in: giftCardIds } }] : []),
              ...(supplierAccountIds.length
                ? [{ supplierAccountId: { in: supplierAccountIds } }]
                : [])
            ]
          }
        });
      }
      if (accountIds.length || orderIds.length || giftCardIds.length) {
        await cleanupTx.idBusinessV2BalanceLedger.deleteMany({
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
        await cleanupTx.idBusinessV2Activation.deleteMany({
          where: { orderId: { in: orderIds } }
        });
        await cleanupTx.idBusinessV2AccountLock.deleteMany({
          where: { orderId: { in: orderIds } }
        });
        await cleanupTx.idBusinessV2Order.deleteMany({
          where: { id: { in: orderIds } }
        });
      }
      if (giftCardIds.length) {
        await cleanupTx.idBusinessV2GiftCard.deleteMany({
          where: { id: { in: giftCardIds } }
        });
      }
      if (accountIds.length) {
        await cleanupTx.idBusinessV2Account.deleteMany({
          where: { id: { in: accountIds } }
        });
      }
      if (customerIds.length) {
        await cleanupTx.idBusinessV2Customer.deleteMany({
          where: { id: { in: customerIds } }
        });
      }
      if (supplierAccountIds.length) {
        await cleanupTx.idBusinessV2TopupSupplierAccount.deleteMany({
          where: { id: { in: supplierAccountIds } }
        });
      }
      for (const optionId of [...optionIds].reverse()) {
        await cleanupTx.idBusinessV2Option.deleteMany({ where: { id: optionId } });
      }
    });
  }

  try {
    await prisma.$connect();

    for (const path of [
      '/id-business-v2/options/business-tree',
      '/id-business-v2/customers',
      '/id-business-v2/accounts',
      '/id-business-v2/balances/workbench',
      '/id-business-v2/orders',
      '/id-business-v2/activations',
      '/id-business-v2/renewals/workbench',
      '/id-business-v2/exchange-rates'
    ]) {
      const unauthorized = await request(path, { tokenOverride: null });
      assert.equal(unauthorized.response.status, 401, `未登录 ${path} 应返回 401`);
    }

    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assert.ok(login?.accessToken, '管理员登录未返回 accessToken');
    token = login.accessToken;

    const statusSelectors = await api('/id-business-v2/options/selectors?type=id_status');
    const normalStatus = statusSelectors.items.find((item) => item.code === 'normal');
    assert.ok(normalStatus, '缺少系统固定 ID 状态 normal');

    const locationName = `V2801 美国 ${suffix}`;
    const country = await createOption('country', locationName, null, { currencyCode: 'USD' });
    const category = await createOption('business_category', `V2801 分类 ${suffix}`);
    const service = await createOption('service', `V2801 服务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });
    const source = await createOption('customer_source', `V2801 来源 ${suffix}`);
    const customerTag = await createOption('customer_tag', `V2801 标签 ${suffix}`);
    const idSupplier = await createOption('id_supplier', `V2801 ID供应商 ${suffix}`);
    const topupSupplier = await createOption('topup_supplier', `V2801 加卡供应商 ${suffix}`);
    const settlementPlatform = await createOption(
      'settlement_platform',
      `V2801 结算平台 ${suffix}`,
      null,
      { fixedFee: '1', percentageFee: '2' }
    );

    const supplierOpening = await api(
      `/id-business-v2/topup-supplier-funds/suppliers/${topupSupplier.id}/initialize`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetBalanceCny: '1000',
          reason: 'V2801 隔离验收期初余额',
          idempotencyKey: `v2801-supplier-opening-${suffix}`
        })
      }
    );
    objectIds.add(supplierOpening.ledgerEntry.id);
    const supplierAccount = await prisma.idBusinessV2TopupSupplierAccount.findUniqueOrThrow({
      where: {
        supplierOptionId_currency: { supplierOptionId: topupSupplier.id, currency: 'CNY' }
      },
      select: { id: true }
    });
    supplierAccountIds.push(supplierAccount.id);
    objectIds.add(supplierAccount.id);

    const businessTree = await api('/id-business-v2/options/business-tree');
    assert.ok(
      businessTree.items.some(
        (treeCountry) =>
          treeCountry.id === country.id &&
          treeCountry.children.some(
            (treeCategory) =>
              treeCategory.id === category.id &&
              treeCategory.children.some((treeService) => treeService.id === service.id)
          )
      ),
      '选项设置没有持久化国家、分类、服务层级'
    );

    const customerPhone = `155${suffix.slice(-8)}`;
    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `V2801 客户 ${suffix}`,
        phone: customerPhone,
        wechat: `v2801_wechat_${suffix}`,
        sourceOptionId: source.id,
        tagOptionIds: [customerTag.id],
        sortOrder: 28,
        remark: 'V2801 Excel 验收客户'
      })
    });
    customerIds.push(customer.id);
    objectIds.add(customer.id);
    const customerDetail = await api(`/id-business-v2/customers/${customer.id}`);
    assert.equal(customerDetail.source.id, source.id, '客户详情缺少来源');
    assert.deepEqual(customerDetail.tagOptionIds, [customerTag.id], '客户详情缺少客户标签');
    assert.deepEqual(customerDetail.serviceOptionIds, [], '客户创建时不应伪造开通业务');
    assert.equal(customerDetail.hasPhone, true);
    assert.equal(
      JSON.stringify(customerDetail).includes(customerPhone),
      false,
      '客户详情泄露手机号'
    );

    const appleId = `v2801.primary.${suffix}@example.com`;
    const accountPhone = `166${suffix.slice(-8)}`;
    const securityInfo = `V2801-security-${suffix}`;
    const account = await createAccount({
      appleId,
      countryOptionId: country.id,
      statusOptionId: normalStatus.id,
      supplierOptionId: idSupplier.id,
      phone: accountPhone,
      securityInfo,
      sortOrder: 28
    });
    const secondaryAppleId = `v2801.secondary.${suffix}@example.com`;
    const secondaryAccount = await createAccount({
      appleId: secondaryAppleId,
      countryOptionId: country.id,
      statusOptionId: normalStatus.id,
      supplierOptionId: idSupplier.id,
      phone: null,
      securityInfo: null,
      sortOrder: 29
    });

    const accountDetail = await api(`/id-business-v2/accounts/${account.id}`);
    assert.equal(accountDetail.hasPassword, true);
    assert.equal(accountDetail.hasPhone, true);
    assert.equal(accountDetail.hasSecurityInfo, true);
    assert.equal(accountDetail.country.id, country.id);
    assert.equal(accountDetail.supplier.id, idSupplier.id);
    const accountDetailText = JSON.stringify(accountDetail);
    for (const secret of [appleId, accountPhone, securityInfo, `V2801-${suffix}-28-Password!`]) {
      assert.equal(accountDetailText.includes(secret), false, `ID 详情泄露敏感明文：${secret}`);
    }

    const { credit: primaryCredit, code: primaryGiftCardCode } = await creditAccount(
      account.id,
      topupSupplier.id,
      'PRIMARY',
      '30'
    );
    const { credit: secondaryCredit } = await creditAccount(
      secondaryAccount.id,
      topupSupplier.id,
      'SECONDARY',
      '5'
    );
    assertDecimal(primaryCredit.ledgerEntry.balanceAfter, '30', '主 ID 加卡后余额');
    assertDecimal(primaryCredit.ledgerEntry.costAfter, '90', '主 ID 加卡后成本');
    assertDecimal(secondaryCredit.ledgerEntry.balanceAfter, '5', '次 ID 加卡后余额');

    const preActivationWorkbench = await api(
      '/id-business-v2/balances/workbench?page=1&pageSize=100'
    );
    const preActivationRow = preActivationWorkbench.items.find((item) => item.id === account.id);
    assert.ok(preActivationRow, '加卡工作台缺少主 ID');
    assert.equal(preActivationRow.serviceDataAvailable, true);
    assert.deepEqual(preActivationRow.historicalServices, []);
    assert.deepEqual(preActivationRow.currentServices, []);

    const giftCardRecords = await api(
      `/id-business-v2/gift-cards/records?accountId=${account.id}&page=1&pageSize=100`
    );
    assert.equal(giftCardRecords.total, 1, '按 ID 查看加卡记录没有隔离其他 ID');
    assert.ok(giftCardRecords.items.every((item) => item.account.id === account.id));
    assert.equal(JSON.stringify(giftCardRecords).includes(primaryGiftCardCode), false);

    const balanceLedger = await api(
      `/id-business-v2/gift-cards/balance-ledger?accountId=${account.id}&page=1&pageSize=100`
    );
    assert.equal(balanceLedger.total, 1, '按 ID 查看余额流水没有隔离其他 ID');
    assert.ok(balanceLedger.items.every((item) => item.account.id === account.id));

    const entryOptions = await api(
      `/id-business-v2/orders/entry-options?customerKeyword=${encodeURIComponent(customer.name)}`
    );
    assert.equal(entryOptions.customers.length, 1, '订单录入客户搜索结果不准确');
    assert.equal(entryOptions.customers[0].id, customer.id);
    assert.ok(
      entryOptions.countries.some(
        (entryCountry) =>
          entryCountry.id === country.id &&
          entryCountry.children.some(
            (entryCategory) =>
              entryCategory.id === category.id &&
              entryCategory.children.some((entryService) => entryService.id === service.id)
          )
      ),
      '订单录入没有返回真实业务层级'
    );
    assert.ok(
      entryOptions.settlementPlatforms.some((platform) => platform.id === settlementPlatform.id),
      '订单录入没有返回真实结算平台'
    );

    const matching = await api(
      `/id-business-v2/orders/matching-candidates?serviceOptionId=${service.id}&balanceAmount=20&limit=20`
    );
    assert.equal(matching.selectedCandidateId, account.id, '自动匹配没有选中余额充足的主 ID');
    assert.equal(
      matching.items.some((item) => item.id === secondaryAccount.id),
      false,
      '余额不足的次 ID 错误进入候选'
    );

    const openedAt = new Date();
    const dueAt = new Date(openedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const websiteAccount = `v2801.website.${suffix}@example.com`;
    const createdOrder = await api('/id-business-v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        serviceOptionId: service.id,
        accountId: account.id,
        settlementPlatformOptionId: settlementPlatform.id,
        platformOrderNo: `V2801-${suffix}`,
        websiteAccount,
        receivedAmount: '100',
        balanceAmount: '20',
        accountDisposition: 'retained',
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        lockScope: 'by_service',
        idempotencyKey: `v2801-order-${suffix}`,
        sortOrder: 28,
        remark: 'V2801 Excel 订单验收'
      })
    });
    orderIds.push(createdOrder.order.id);
    objectIds.add(createdOrder.order.id);
    if (createdOrder.lock?.id) objectIds.add(createdOrder.lock.id);
    assert.equal(createdOrder.order.status, 'pending');
    assertDecimal(createdOrder.order.platformFeeAmount, '3', '订单平台手续费');

    const consumed = await api(`/id-business-v2/orders/${createdOrder.order.id}/consume-balance`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `v2801-consume-${suffix}` })
    });
    objectIds.add(consumed.ledgerEntry.id);
    assert.equal(consumed.order.status, 'processing');
    assertDecimal(consumed.ledgerEntry.balanceAfter, '10', '订单扣款后余额');
    assertDecimal(consumed.order.profitAmount, '37', '订单利润');

    const completed = await api(`/id-business-v2/orders/${createdOrder.order.id}/complete`, {
      method: 'POST'
    });
    objectIds.add(completed.activation.id);
    assert.equal(completed.order.status, 'completed');
    assert.equal(completed.activation.status, 'active');

    const orderList = await api(
      `/id-business-v2/orders?keyword=${encodeURIComponent(
        createdOrder.order.orderNo
      )}&page=1&pageSize=20`
    );
    assert.equal(orderList.total, 1);
    assert.equal(orderList.items[0].id, createdOrder.order.id);
    assert.equal(JSON.stringify(orderList).includes(websiteAccount), false);

    const activationList = await api(
      `/id-business-v2/activations?keyword=${encodeURIComponent(
        createdOrder.order.orderNo
      )}&page=1&pageSize=20`
    );
    assert.equal(activationList.total, 1);
    assert.equal(activationList.items[0].id, completed.activation.id);
    const activationDetail = await api(`/id-business-v2/activations/${completed.activation.id}`);
    assert.equal(activationDetail.customer.id, customer.id);
    assert.equal(activationDetail.account.id, account.id);
    assert.equal(activationDetail.service.id, service.id);

    const postActivationWorkbench = await api(
      '/id-business-v2/balances/workbench?page=1&pageSize=100'
    );
    const activeRow = postActivationWorkbench.items.find((item) => item.id === account.id);
    assert.deepEqual(
      activeRow.historicalServices.map((item) => item.id),
      [service.id],
      '加卡工作台历史服务不是来自真实开通记录'
    );
    assert.deepEqual(
      activeRow.currentServices.map((item) => item.id),
      [service.id],
      '加卡工作台当前服务不是来自有效开通记录'
    );
    assert.equal(activeRow.topupRecordCount, 1);
    assert.equal(activeRow.balanceChangeCount, 2);

    const renewalList = await api(
      `/id-business-v2/renewals/workbench?accountId=${account.id}&page=1&pageSize=20`
    );
    assert.equal(renewalList.total, 1, '续费工作台没有返回真实开通记录');
    assert.equal(renewalList.items[0].customer.id, customer.id);
    assert.equal(renewalList.items[0].account.id, account.id);
    assert.equal(renewalList.items[0].service.id, service.id);

    const storedCustomer = await prisma.idBusinessV2Customer.findUniqueOrThrow({
      where: { id: customer.id }
    });
    const storedAccount = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    const storedOrder = await prisma.idBusinessV2Order.findUniqueOrThrow({
      where: { id: createdOrder.order.id }
    });
    const storedActivation = await prisma.idBusinessV2Activation.findUniqueOrThrow({
      where: { id: completed.activation.id }
    });
    assert.ok(storedCustomer.phoneEncrypted, '客户手机号没有加密持久化');
    assert.ok(storedAccount.passwordEncrypted, 'ID 密码没有加密持久化');
    assert.ok(storedAccount.phoneEncrypted, 'ID 手机号没有加密持久化');
    assert.ok(storedAccount.securityInfoEncrypted, 'ID 密保没有加密持久化');
    assert.equal(storedOrder.status, 'completed');
    assert.equal(storedActivation.status, 'active');
    assertDecimal(storedAccount.currentBalance, '10', '数据库当前余额');
    assertDecimal(storedAccount.balanceCostAmount, '30', '数据库余额成本');

    const metadataRemark = `V2801 metadata ${suffix}`;
    const updatedGiftCard = await api(
      `/id-business-v2/gift-cards/${primaryCredit.giftCard.id}/metadata`,
      {
        method: 'PATCH',
        body: JSON.stringify({ remark: metadataRemark })
      }
    );
    assert.equal(updatedGiftCard.remark, metadataRemark, '礼品卡非账务备注没有持久化');
    assertDecimal(updatedGiftCard.faceValue, '30', '修改备注后礼品卡面值');
    assertDecimal(updatedGiftCard.exchangeRate, '3', '修改备注后礼品卡汇率');

    const reversibleGiftCards = await api(
      `/id-business-v2/gift-cards/${secondaryAccount.id}/reversible`
    );
    assert.equal(reversibleGiftCards.total, 1, '次 ID 的可反向礼品卡数量不正确');
    assert.equal(reversibleGiftCards.items[0].id, secondaryCredit.giftCard.id);
    const reversalReason = `V2801 isolated withdrawal ${suffix}`;
    const reversal = await api(
      `/id-business-v2/gift-cards/${secondaryCredit.giftCard.id}/reversals`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'withdrawn',
          reason: reversalReason,
          idempotencyKey: `v2801-withdrawal-${suffix}`
        })
      }
    );
    objectIds.add(reversal.ledgerEntry.id);
    assert.equal(reversal.action, 'withdrawn');
    assert.equal(reversal.giftCard.status, 'withdrawn');
    assert.equal(reversal.ledgerEntry.entryType, 'gift_card_withdrawal');
    assert.equal(reversal.ledgerEntry.reversalOfEntryId, secondaryCredit.ledgerEntry.id);
    assertDecimal(reversal.account.currentBalance, '0', '礼品卡撤回后次 ID 余额');
    assertDecimal(reversal.account.balanceCostAmount, '0', '礼品卡撤回后次 ID 成本');
    const reversalReplay = await api(
      `/id-business-v2/gift-cards/${secondaryCredit.giftCard.id}/reversals`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'withdrawn',
          reason: reversalReason,
          idempotencyKey: `v2801-withdrawal-${suffix}`
        })
      }
    );
    assert.equal(reversalReplay.idempotentReplay, true, '礼品卡撤回没有幂等重放');

    const runtime = await api('/id-business-v2/exchange-rates/runtime');
    assert.equal(runtime.settings.autoEnabled, true, '汇率自动采集没有默认开启');
    assert.equal(runtime.settings.emergencyNetworkEnabled, true, '汇率网络采集紧急开关未开启');
    assert.deepEqual(runtime.providers.map((provider) => provider.code).sort(), ['binance', 'okx']);
    await waitForExchangeIdle();
    const manualRate = await api('/id-business-v2/exchange-rates/collect', { method: 'POST' });
    assert.ok(manualRate.runId, '人工采集未返回运行 ID');
    assert.ok(new Prisma.Decimal(manualRate.midRateToRmb).greaterThan(0));
    const rateDetail = await api(`/id-business-v2/exchange-rates/runs/${manualRate.runId}`);
    assert.equal(rateDetail.triggerType, 'manual');
    assert.equal(rateDetail.status, 'success');
    assert.equal(rateDetail.providerSnapshots.length, 4);
    assert.deepEqual(
      rateDetail.providerSnapshots
        .map((snapshot) => `${snapshot.provider}:${snapshot.side}`)
        .sort(),
      ['binance:merchant_buy', 'binance:merchant_sell', 'okx:merchant_buy', 'okx:merchant_sell']
    );

    const auditLogs = await prisma.auditLog.findMany({
      where: { objectId: { in: [...objectIds] } },
      select: { action: true, beforeData: true, afterData: true, remark: true }
    });
    assert.ok(auditLogs.length > 0, '真实写操作没有审计日志');
    const auditText = JSON.stringify(auditLogs);
    for (const secret of [
      customerPhone,
      appleId,
      accountPhone,
      securityInfo,
      primaryGiftCardCode,
      websiteAccount
    ]) {
      assert.equal(auditText.includes(secret), false, `审计日志泄露敏感明文：${secret}`);
    }

    resultSummary = {
      ok: true,
      suffix,
      worksheets: {
        '工作台-续费操作': true,
        '工作台-订单录入': true,
        '工作台-加卡': true,
        ID录入: true,
        订单管理: true,
        客户记录: true,
        加卡记录: true,
        开通记录: true,
        汇率采集: true,
        选项设置: true
      },
      checks: {
        unauthenticatedRejected: true,
        optionHierarchyPersisted: true,
        customerAndAccountDetailsAreMasked: true,
        sensitiveFieldsEncryptedAtRest: true,
        accountScopedGiftCardAndLedgerRecords: true,
        realOrderMatchDebitAndCompletion: true,
        activationBackedHistoricalAndCurrentServices: true,
        renewalWorkbenchUsesActivationData: true,
        giftCardMetadataAndReversalAreReal: true,
        realExchangeRateCollection: true,
        auditContainsNoSecrets: true
      },
      records: {
        customerId: customer.id,
        accountId: account.id,
        orderId: createdOrder.order.id,
        activationId: completed.activation.id,
        exchangeRateRunId: manualRate.runId
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
    throw new Error(`V2801 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`V2801 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
