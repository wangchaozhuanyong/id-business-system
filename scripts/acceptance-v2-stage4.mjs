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
    // Missing files are reported later through the required configuration checks.
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');

  const apiBaseUrl = trimTrailingSlash(
    process.env.V2_STAGE4_ACCEPTANCE_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const username = process.env.V2_STAGE4_ACCEPTANCE_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_STAGE4_ACCEPTANCE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

  assert(username && password, '缺少 Stage 4 验收管理员账号配置');
  assertLocalAcceptanceDatabase(apiBaseUrl, process.env.DATABASE_URL);

  const prisma = new PrismaClient();
  const suffix = `${Date.now()}`.slice(-10);
  const createdOptionIds = [];
  let token = '';
  let customerId = '';
  let accountId = '';
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
        remark: `Stage 4 API QA ${suffix}`,
        ...extra
      })
    });
    createdOptionIds.push(option.id);
    return option;
  }

  async function removeAcceptanceData() {
    const objectIds = [customerId, accountId, ...createdOptionIds].filter(Boolean);

    if (objectIds.length) {
      await prisma.sensitiveAccessLog.deleteMany({
        where: {
          objectId: {
            in: objectIds
          }
        }
      });
      await prisma.auditLog.deleteMany({
        where: {
          objectId: {
            in: objectIds
          }
        }
      });
    }

    if (accountId) {
      await prisma.idBusinessV2BalanceLedger.deleteMany({
        where: {
          accountId
        }
      });
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
    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assert(login?.accessToken, '管理员登录未返回 accessToken');
    token = login.accessToken;

    const statusSelectors = await api('/id-business-v2/options/selectors?type=id_status');
    const normalStatus = statusSelectors.items.find((item) => item.code === 'normal');
    assert(normalStatus, '缺少系统固定 ID 状态 normal');

    const supplier = await createOption('id_supplier', `Stage4 QA ID供应商 ${suffix}`);
    const source = await createOption('customer_source', `Stage4 QA 来源 ${suffix}`);
    const tag = await createOption('customer_tag', `Stage4 QA 标签 ${suffix}`);
    const country = await createOption('country', `Stage4 QA 国家 ${suffix}`, null, {
      currencyCode: 'USD'
    });
    const category = await createOption('business_category', `Stage4 QA 分类 ${suffix}`);
    const service = await createOption('service', `Stage4 QA 业务 ${suffix}`, category.id, {
      countryOptionId: country.id,
      businessAmount: '10'
    });

    const customerPhone = `139${suffix.slice(-8)}`;
    const customer = await api('/id-business-v2/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Stage4 QA 客户 ${suffix}`,
        phone: customerPhone,
        wechat: `qa_wechat_${suffix}`,
        sourceOptionId: source.id,
        tagOptionIds: [tag.id],
        serviceOptionIds: [service.id],
        sortOrder: 17,
        remark: '真实 API 验收客户'
      })
    });
    customerId = customer.id;

    assert(customer.hasPhone === true, '客户手机号保存状态不正确');
    assert(customer.maskedPhone && customer.maskedPhone !== customerPhone, '客户手机号没有脱敏');
    assert(!JSON.stringify(customer).includes(customerPhone), '客户普通响应泄露手机号明文');

    const customerList = await api(
      `/id-business-v2/customers?page=1&pageSize=20&keyword=${encodeURIComponent(
        suffix
      )}&sourceOptionId=${source.id}&tagOptionId=${tag.id}&serviceOptionId=${
        service.id
      }&recordStatus=active&sortBy=updatedAt&sortOrder=desc`
    );
    assert(
      customerList.items.some((item) => item.id === customerId),
      '客户筛选、排序或分页未返回新记录'
    );

    const customerReveal = await api(`/id-business-v2/customers/${customerId}/reveal-phone`, {
      method: 'POST',
      body: JSON.stringify({ reason: `Stage 4 客户手机号验收 ${suffix}` })
    });
    assert(customerReveal.phone === customerPhone, '客户手机号解密结果不一致');

    const appleId = `stage4.qa.${suffix}@example.com`;
    const accountPassword = `Stage4-Pass-${suffix}!`;
    const accountPhone = `137${suffix.slice(-8)}`;
    const securityInfo = `QA security ${suffix}`;
    const account = await api('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId,
        password: accountPassword,
        phone: accountPhone,
        securityInfo,
        countryOptionId: country.id,
        statusOptionId: normalStatus.id,
        supplierOptionId: supplier.id,
        currentBalance: '20',
        balanceCostAmount: '70',
        purchaseCost: '123.45',
        sortOrder: 23,
        remark: '真实 API 验收 ID'
      })
    });
    accountId = account.id;

    assert(account.appleIdMasked && account.appleIdMasked !== appleId, 'Apple ID 没有脱敏');
    assert(
      account.hasPassword && account.hasPhone && account.hasSecurityInfo,
      'ID 敏感字段保存状态不正确'
    );
    assert(
      account.currentBalance === '20' && account.balanceCostAmount === '70',
      '新增 ID 期初余额或人民币成本未保存'
    );

    const accountJson = JSON.stringify(account);
    for (const secret of [appleId, accountPassword, accountPhone, securityInfo]) {
      assert(!accountJson.includes(secret), 'ID 普通响应泄露敏感字段明文');
    }

    const accountList = await api(
      `/id-business-v2/accounts?page=1&pageSize=20&keyword=${encodeURIComponent(
        appleId
      )}&countryOptionId=${country.id}&statusOptionId=${normalStatus.id}&supplierOptionId=${
        supplier.id
      }&recordStatus=active&sortBy=purchaseCost&sortOrder=desc`
    );
    assert(
      accountList.items.some((item) => item.id === accountId),
      'ID 筛选、排序或分页未返回新记录'
    );

    for (const [field, expected] of [
      ['appleId', appleId],
      ['password', accountPassword],
      ['phone', accountPhone],
      ['securityInfo', securityInfo]
    ]) {
      const reveal = await api(`/id-business-v2/accounts/${accountId}/reveal-secret`, {
        method: 'POST',
        body: JSON.stringify({
          field,
          reason: `Stage 4 ID 敏感字段验收 ${suffix}`
        })
      });
      assert(reveal.field === field && reveal.value === expected, `ID ${field} 解密结果不一致`);
    }

    const duplicate = await request('/id-business-v2/accounts', {
      method: 'POST',
      body: JSON.stringify({
        appleId: appleId.toUpperCase(),
        countryOptionId: country.id,
        statusOptionId: normalStatus.id
      })
    });
    assert(
      duplicate.response.status === 409,
      `重复 Apple ID 应返回 409，实际为 ${duplicate.response.status}`
    );

    const updatedCustomer = await api(`/id-business-v2/customers/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: `Stage4 QA 客户已更新 ${suffix}`,
        recordStatus: 'disabled',
        sortOrder: 18
      })
    });
    assert(
      updatedCustomer.recordStatus === 'disabled' && updatedCustomer.sortOrder === 18,
      '客户更新或停用未生效'
    );

    const updatedAccount = await api(`/id-business-v2/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        recordStatus: 'disabled',
        purchaseCost: '125.67',
        sortOrder: 24,
        currentBalance: '15',
        balanceCostAmount: '45',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        balanceAdjustmentReason: 'Stage 4 手工修正',
        balanceAdjustmentIdempotencyKey: `stage4-adjustment-${suffix}`
      })
    });
    assert(
      updatedAccount.recordStatus === 'disabled' &&
        updatedAccount.purchaseCost === '125.67' &&
        updatedAccount.currentBalance === '15' &&
        updatedAccount.balanceCostAmount === '45',
      'ID 更新或停用未生效'
    );

    const dbCustomer = await prisma.idBusinessV2Customer.findUnique({
      where: { id: customerId }
    });
    const dbAccount = await prisma.idBusinessV2Account.findUnique({
      where: { id: accountId }
    });

    assert(dbCustomer?.phoneEncrypted?.startsWith('v1:'), '客户手机号未按 AES-GCM v1 格式加密');
    assert(!dbCustomer.phoneEncrypted.includes(customerPhone), '客户手机号密文字段包含明文');

    for (const [label, encrypted, plaintext] of [
      ['appleId', dbAccount?.appleIdEncrypted, appleId],
      ['password', dbAccount?.passwordEncrypted, accountPassword],
      ['phone', dbAccount?.phoneEncrypted, accountPhone],
      ['securityInfo', dbAccount?.securityInfoEncrypted, securityInfo]
    ]) {
      assert(encrypted?.startsWith('v1:'), `${label} 未按 AES-GCM v1 格式加密`);
      assert(!encrypted.includes(plaintext), `${label} 密文字段包含明文`);
    }
    assert(
      dbAccount.currentBalance.toString() === '15' &&
        dbAccount.balanceCostAmount.toString() === '45',
      '数据库余额或人民币成本修正未落库'
    );
    const balanceEntries = await prisma.idBusinessV2BalanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' }
    });
    assert(balanceEntries.length === 2, '期初余额和手工修正流水数量不正确');
    assert(balanceEntries[0]?.entryType === 'opening_balance', '缺少期初余额流水');
    assert(balanceEntries[1]?.entryType === 'manual_adjustment', '缺少手工修正流水');
    assert(
      balanceEntries[1]?.balanceBefore.toString() === '20' &&
        balanceEntries[1]?.balanceAfter.toString() === '15' &&
        balanceEntries[1]?.costBefore.toString() === '70' &&
        balanceEntries[1]?.costAfter.toString() === '45',
      '手工修正流水快照不正确'
    );

    const sensitiveLogs = await prisma.sensitiveAccessLog.findMany({
      where: {
        objectId: {
          in: [customerId, accountId]
        }
      },
      select: {
        objectId: true,
        fieldName: true
      }
    });
    const sensitiveFields = sensitiveLogs.map((item) => `${item.objectId}:${item.fieldName}`);

    for (const expected of [
      `${customerId}:phone`,
      `${accountId}:appleId`,
      `${accountId}:password`,
      `${accountId}:phone`,
      `${accountId}:securityInfo`
    ]) {
      assert(sensitiveFields.includes(expected), `缺少敏感访问日志 ${expected.split(':').at(-1)}`);
    }

    await api(`/id-business-v2/accounts/${accountId}/record-status`, {
      method: 'POST',
      body: JSON.stringify({ recordStatus: 'disabled', reason: 'Stage 4 验收停用' })
    });

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        objectId: {
          in: [customerId, accountId]
        }
      },
      select: {
        action: true,
        beforeData: true,
        afterData: true
      }
    });
    const auditActions = new Set(auditLogs.map((item) => item.action));

    for (const action of [
      'id_business_v2.customer.create',
      'id_business_v2.customer.update',
      'id_business_v2.customer.phone.reveal',
      'id_business_v2.account.create',
      'id_business_v2.account.update',
      'id_business_v2.account.disable',
      'id_business_v2.account.secret.reveal'
    ]) {
      assert(auditActions.has(action), `缺少操作日志 ${action}`);
    }

    const auditJson = JSON.stringify(auditLogs);
    for (const secret of [customerPhone, appleId, accountPassword, accountPhone, securityInfo]) {
      assert(!auditJson.includes(secret), '操作日志中出现敏感明文');
    }

    await api(`/id-business-v2/customers/${customerId}`, { method: 'DELETE' });

    const disabledAccount = await prisma.idBusinessV2Account.findUnique({
      where: { id: accountId }
    });
    const deletedCustomer = await prisma.idBusinessV2Customer.findUnique({
      where: { id: customerId }
    });

    assert(
      !disabledAccount?.deletedAt &&
        disabledAccount?.recordStatus === 'disabled' &&
        disabledAccount.disabledReason === 'Stage 4 验收停用',
      'ID 停用状态或原因未落库'
    );
    assert(deletedCustomer?.deletedAt, '客户软删除未落库');
    assert(
      (
        await api(
          `/id-business-v2/accounts?page=1&pageSize=20&lifecycle=disabled&keyword=${encodeURIComponent(
            appleId
          )}`
        )
      ).items.some((item) => item.id === accountId),
      '停用 ID 未出现在停用分类'
    );
    assert(
      (
        await api(
          `/id-business-v2/customers?page=1&pageSize=20&keyword=${encodeURIComponent(suffix)}`
        )
      ).total === 0,
      '软删除客户仍出现在列表'
    );

    resultSummary = {
      ok: true,
      checks: {
        realCrud: true,
        filtersSortPagination: true,
        encryptedAtRest: true,
        maskedByDefault: true,
        auditedReveal: true,
        duplicateAppleIdRejected: true,
        editableOpeningBalance: true,
        immutableManualAdjustment: true,
        plaintextAccountListDisabled: true,
        accountLifecycleManagement: true,
        customerSoftDelete: true
      },
      sensitiveAccessLogCount: sensitiveLogs.length,
      auditLogCount: auditLogs.length
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await removeAcceptanceData();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    await prisma.$disconnect();
  }

  if (primaryError) {
    throw primaryError;
  }
  if (cleanupErrors.length) {
    throw new Error(`Stage 4 验收数据清理失败：${cleanupErrors.join(' | ')}`);
  }

  console.log(JSON.stringify(resultSummary, null, 2));
}

main().catch((error) => {
  console.error(`Stage 4 acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
