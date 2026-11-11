import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validOrderCurrencies, validOrderCurrencyGroups, retainOrderSettings } from './order-currency-settings.mjs';
import { isDeepStrictEqual } from 'node:util';
import {
  applyOrderCompletion, assignMissingManualOrderOwners, fillManualOrderDetails,
  OrderCompletionError, readOrderCompletion, rechargePriceSnapshot, requireCompletionActor
} from './order-completion.mjs';
import { checkTenantTransferHistory, planTenantOwnerTransfer, tenantOwnerTransferView, TenantOwnerTransferError } from './tenant-owner-transfer.mjs';
import { prepareTenantRenewalWrite, tenantRenewalHandledAction, tenantRenewalSettingsAction } from './tenant-renewal-reminders.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { validCurrencyCode, snapshotAction } from '../modules/finance/accounting.mjs';
import { checkFinanceSnapshots, historicalFeeAction } from './finance/snapshot-integrity.mjs';
import { appendWebsiteVisit, getWebsiteVisitIp, reportWebsiteVisits, websiteVisitsDomain } from './tools/website-visits.mjs';
import {
  applyMailboxPoolWrite, findMailboxQuery, mailboxPoolCodePage, mailboxPoolItems, mailboxPoolMetadata,
  managedMailboxDomain, MailboxPoolError, prepareVerifiedMailboxWrite
} from './tools/mailbox-pool.mjs';
import { withClaudeMailboxCandidates } from './tools/claude-mailbox-candidates.mjs';
import {
  applyTotpWrite, generateSavedCode, generateSavedCodePage, revealSavedTotpSecret, savedTotpDomain,
  savedTotpMetadata, SavedTotpError, validateTotpWrite
} from './tools/saved-totp.mjs';
import {
  BitBrowserAddressError,
  bitBrowserAddressDomain,
  deleteUsedBitBrowserAddresses,
  generateBitBrowserAddresses,
  importBitBrowserAddresses,
  isBitBrowserAddressId,
  listBitBrowserAddresses,
  updateBitBrowserAddress
} from './bitbrowser-addresses.mjs';
import {
  BitBrowserConnectionError,
  bitBrowserConnectionDomain,
  readBitBrowserConnectionSecrets,
  summarizeBitBrowserConnections,
  validateBitBrowserConnectionWrite,
  writeBitBrowserConnection
} from './bitbrowser-connections.mjs';
import { bitBrowserWindowDomain, BitBrowserWindowError, readWindowRecord, writeWindowRecord } from './bitbrowser-login-windows.mjs';
import { bitBrowserProxyDomain, validateBitBrowserProxyWrite, summarizeBitBrowserProxies, readBitBrowserProxy } from './bitbrowser-proxies.mjs';
import { checkInventoryHistory } from './inventory-history.mjs';
import { prepareMailboxPlatformMarks } from './mailbox-registration-platform.mjs';
import { planHistoricalIntake, requireHistoricalIntake, stageHistoricalIntake } from './apple-relay/historical-intake.mjs';
import {
  ClaudeHistoryIntakeError, claudeHistoryPreview, planClaudeHistoryIntake, stageClaudeHistoryIntake
} from './claude-history-intake.mjs';
import { validMailExtractionSettings } from './inventory-extraction-settings.mjs';
import { checkInventoryEntryFields } from './inventory-entry-fields.mjs';
import { personalOrderError, personalProduct, preparePersonalInventory } from './personal-subscriptions.mjs';
import { stageInitialTenantCards } from './tenant-initial-cards.mjs';
import { AccountLifecycleError, accountLifecycleSummaries, changeAccountLifecycle, checkInventoryRenewals, applyAccountOrderLifecycle } from './account-lifecycle.mjs';
import { planLegacyMailboxImport } from './tools/legacy-mailbox-import.mjs';
import { planLegacyTotpImport } from './tools/legacy-totp-import.mjs';
import { applyInventoryUsage, correctInventoryUsage, inspectInventoryUsage, usageReviewRows } from './inventory-usage.mjs';
import { checkRegistrationChanges } from './inventory-registration.mjs';
import { attributeInventory, defaultInventoryRegistrationTimes } from './inventory-attribution.mjs';
import { checkAccountLocations } from './inventory-account-location.mjs';
import { emptyAppleLedger, stageAppleOpenings, stageAppleOrderFunding } from './apple-funding.mjs';
import {
  bankRenewalSource, cardFreezeDocument, cardTypeDocument, cardTypeSnapshot, frozenOrderCard, frozenRenewalCard,
  orderCardArchiveDocument
} from './card-management.mjs';
import { claudeGoogleCopyDomainPrefix, validateClaudeGoogleCopySettings } from './claude-google-subscriptions.mjs';
import { legacyOpeningOrderIds, ownerForSubscriptionOrder, subscriptionDomain } from './subscription-management.mjs';
import { subscriptionTime } from '../frontend/order-opening.mjs';
import {
  assignOrderOwner, assignTenantOwner, checkClaudeProMaterialHistory,
  checkClaudeProRenewalSource, checkNewOrder, checkSubscriptionTermination, deriveCardIssueFee, historicalGptCardBackfillError,
  isOrderBankMaterials, manualOrderDetailsAction, nextOrderNo, normalizeClaudeCertification, normalizeClaudeProMaterials,
  redactClaudeProOrderMaterials, retainOrderCardNumber, normalizePaymentEvidence,
  validClaudePaidPrices, validGptPaidPrices, validMoney, validOrderPrices, validPersonalPaidPrices, validApplePaidPrices
} from './order-policy.mjs';
import {
  pendingRelayClaimIds,
  RelayClaimError,
  requireVerifiedRelayClaimIds
} from './relay-claim-integrity.mjs';
import {
  checkAppleLedger,
  checkBankReturns,
  checkOrderFinancialHistory,
  checkRelayInventory,
  checkStockDeliveries
} from './local-business-integrity.mjs';

export const bitBrowserDefaultsDomain = 'bitbrowser-defaults';
const bitBrowserDefaultKeys = {
  [bitBrowserConnectionDomain]: 'connectionId',
  [bitBrowserProxyDomain]: 'proxyId'
};

const domainLabels = {
  inventory: '库存',
  commerce: '客户与订单',
  settings: '业务设置',
  appleBalance: '苹果 ID 余额'
};
const allowedDomains = new Set(Object.keys(domainLabels));
const verifiedAppleRelayPrimaries = Symbol('verifiedAppleRelayPrimaries');
const stagedRelayIntake = Symbol('stagedRelayIntake');
const inventoryLists = [
  'mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords',
  'registrationRecords', 'tableSettings', 'undo'
];
const inventoryActions = {
  inventory_edit: '修改库存资料',
  inventory_create: '新增库存资料',
  inventory_extract: '提取库存',
  inventory_return: '归还库存',
  inventory_use: '确认使用库存',
  inventory_import: '批量导入库存',
  inventory_health_change: '变更库存状态',
  inventory_undo: '撤回库存修改',
  inventory_delete: '删除库存资料',
  inventory_table_settings: '保存库存表设置',
  inventory_registration_result: '登记注册结果',
  inventory_order_sale: '成品交付占用库存',
  inventory_reconcile_usage: '核对库存使用关联',
  inventory_relay_parent_save: '保存苹果主邮箱',
  inventory_relay_alias_save: '登记苹果隐藏邮箱',
  inventory_relay_alias_import: '批量登记苹果隐藏邮箱',
  inventory_relay_history_import: '历史入库苹果隐藏邮箱'
};
const settingsActions = {
  customer_tags_save: '保存客户标签设置',
  customer_sources_save: '保存客户来源设置',
  mailbox_category_save: '保存邮箱分类',
  mailbox_category_reorder: '调整邮箱分类排序',
  fee_rules_save: '保存费用规则',
  statistics_currency_save: '更改统计币种',
  order_prices_save: '保存订单套餐售价',
  order_currencies_save: '保存订单币种设置',
  apple_paid_prices_save: '保存苹果内购代付价',
  gpt_paid_prices_save: '保存 GPT 代付价格',
  claude_paid_prices_save: '保存 Claude 代付价格',
  personal_paid_prices_save: '保存 Gemini／Grok 代付价格'
};
const appleBalanceActions = {
  apple_order_charge: '登记苹果内购扣款或冲正',
  apple_refund_schedule: '登记 Apple 待回款',
  apple_refund_correct: '更正 Apple 待回款',
  apple_refund_receive: '确认 Apple 回款到账',
  apple_adjust: '登记苹果 ID 余额变动',
  apple_opening: '登记苹果 ID 期初余额',
  apple_topup: '登记苹果 ID 充值到账',
  apple_adjust_undo: '补偿撤回苹果 ID 余额变动'
};
const actionsByDomain = {
  inventory: new Set(Object.keys(inventoryActions)),
  commerce: new Set([
    '新增资料',
    '修改资料',
    '停用资料',
    '恢复资料',
    '新增独立订单',
    '更新续费提醒设置',
    tenantRenewalSettingsAction,
    tenantRenewalHandledAction,
    '拒续费',
    '恢复续费提醒',
    snapshotAction,
    historicalFeeAction,
    '更正订单',
    '退款登记',
    '银行卡回款登记',
    '补偿撤回更正',
    '业务撤单',
    '恢复业务订单',
    '建立租金发放批次',
    '租金发放登记',
    '恢复使用',
    '冻结',
    '弃用'
  ]),
  settings: new Set(Object.keys(settingsActions)),
  appleBalance: new Set(Object.keys(appleBalanceActions))
};
const actionLabels = {
  inventory: inventoryActions,
  settings: settingsActions,
  appleBalance: appleBalanceActions
};
const sessionEventLabels = {
  auth_nickname_set: '设置员工昵称',
  auth_login: '员工登录',
  auth_logout: '退出登录',
  auth_session_revoke: '退出登录设备',
  auth_employee_create: '新增员工账号',
  auth_employee_update: '修改员工账号',
  relay_test: '测试苹果主邮箱连接',
  relay_test_failed: '苹果主邮箱连接测试失败',
  relay_sync: '同步苹果隐藏邮箱邮件',
  relay_query: '查询苹果隐藏邮箱',
  relay_public_query: '公开查询隐藏邮箱',
  relay_read_code: '查看苹果邮箱查询码',
  relay_reset_code: '重置苹果邮箱查询码',
  relay_mail_reassign: '分配苹果邮箱邮件归属',
  relay_history_preview: '预检苹果邮箱历史邮件归属'
};
const orderFeatureDomains = new Set([
  'recharge-codes', 'tenant-cards', 'order-sync', 'finance-rates', cardTypeDocument, orderCardArchiveDocument,
  cardFreezeDocument, 'system-monitoring-config', 'system-monitoring-state', subscriptionDomain
]);
const orderFeatureAuditLabels = {
  monitor_settings: '保存监控与通知设置',
  monitor_test: '提交 Telegram 测试投递',
  monitor_acknowledge: '确认监控告警',
  monitor_legacy_import: '导入原代充通知订阅',
  monitor_legacy_begin: '开始接管原代充通知',
  monitor_legacy_finish: '确认接管原代充通知',
  monitor_verified: '登记已核实的监控事件',
  recharge_code_request: '申请充值码',
  recharge_code_approve: '批准充值码申请',
  recharge_code_reject: '驳回充值码申请',
  recharge_code_import_started: '提交充值码批次',
  recharge_code_issue_pending: '充值码发放待核对',
  recharge_code_issued: '确认发放充值码',
  recharge_code_return_started: '登记充值码归还',
  recharge_code_return_pending: '核对充值码归还结果',
  recharge_code_returned: '确认充值码归还'
};
const verifiedOrderCards = Symbol('verifiedOrderCards');
const rechargeEvidenceFields = [
  'source', 'taskId', 'email', 'product', 'plan', 'businessType', 'payment', 'paymentId',
  'cardId', 'paidAmount', 'paidCurrency', 'start', 'expiry', 'paidConfirmed', 'rechargeCompletedAt', 'entitlementStatus',
  'accountSource', 'accountId', 'rechargeOwnerId', 'rechargePriceSnapshot', 'rechargeOwnerAssignment'
];
const defaultOrderCosts = Object.freeze({
  currency: 'CNY', version: 1, claudeBankFeeMyr: '100', claudeAccountCostMyr: '50',
  gmailCostCny: '15', appleCostCny: '25', microsoftCostCny: '5', appleDiscount: '0.8',
  cardIssueUsd: '0.5', cardPercent: '0.008', cardPerPaymentUsd: '0.3'
});
const maximumBodyBytes = 12 * 1024 * 1024;
const localToolboxActor = { id: 'local-operator', name: '本机操作员' };
const verifiedRelayClaimIds = Symbol('verifiedRelayClaimIds');

function auditSummary(label, actor, targetId) {
  return actor
    ? JSON.stringify({ label, actorId: actor.id, actorName: actor.name, targetId })
    : label;
}

function readAuditRow(row) {
  if (!row.summary.startsWith('{')) return row;
  const { label, actorId, actorName, targetId } = JSON.parse(row.summary);
  return { ...row, summary: label, actorId, actorName, targetId };
}


const auditDomainLabels = {
  inventory: '库存',
  commerce: '客户与订单',
  settings: '系统设置',
  auth: '员工与权限',
  toolbox: '个人工具箱',
  appleBalance: '苹果 ID 余额',
  'recharge-codes': '充值码审核',
  'tenant-cards': '租户银行卡',
  [orderCardArchiveDocument]: '订单银行卡留存',
  [cardFreezeDocument]: '银行卡冻结',
  'order-sync': '代充订单同步',
  'finance-rates': '汇率采集',
  'subscription-management': '订阅管理',
  'system-monitoring-config': '监控与通知',
  'system-monitoring-state': '监控中心'
};
const auditActionLabels = {
  customer_tags_save: '保存客户标签设置',
  customer_sources_save: '保存客户来源设置',
  mailbox_category_save: '保存邮箱分类',
  mailbox_category_reorder: '调整邮箱分类顺序',
  fee_rules_save: '保存费用规则',
  statistics_currency_save: '修改统计币种'
};
const auditDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'medium'
});

export function pageAuditRows(rows, search) {
  const view = search.get('view') ?? 'audit';
  const pageSize = Number(search.get('pageSize') ?? 10);
  const requestedPage = Number(search.get('page') ?? 1);
  const query = (search.get('query') ?? '').toLowerCase().trim();
  const currentSnapshot = rows[0]?.id ?? 0;
  const requestedSnapshot = Number(search.get('snapshot') ?? currentSnapshot);
  if (![...search.keys()].every(key =>
    ['view', 'pageSize', 'page', 'query', 'snapshot'].includes(key) && search.getAll(key).length === 1
  ) || !['audit', 'login'].includes(view) || ![10, 20, 50].includes(pageSize) ||
      !Number.isSafeInteger(requestedPage) || requestedPage < 1 ||
      !Number.isSafeInteger(requestedSnapshot) || requestedSnapshot < 0 ||
      (search.get('query')?.length ?? 0) > 120)
    throw new LocalDataError(400, '日志查询条件无效');
  const snapshot = Math.min(currentSnapshot, requestedSnapshot);
  const matches = rows.filter(({ id, domain, action }) =>
    id <= snapshot && (view === 'audit' ||
      (domain === 'auth' && ['auth_login', 'auth_logout'].includes(action))))
    .map(({ id, at, domain, action, summary, actorName }) => {
      const date = new Date(at);
      return {
        id: String(id),
        time: Number.isNaN(date.valueOf()) ? '未知' : auditDate.format(date),
        actor: actorName || '本机操作',
        action: auditActionLabels[action] || summary || '保存资料',
        subject: auditDomainLabels[domain] || domain,
        result: summary || '已保存'
      };
    })
    .filter(row => !query || Object.values(row).some(value => String(value).toLowerCase().includes(query)));
  const total = matches.length;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  return { items: matches.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, snapshot };
}

export function attributeCommerce(data, previous, actor, owners, subscriptions, inventory) {
  checkTenantTransferHistory(data.tenants, previous?.tenants);
  const attributeNew = (rows = [], before = []) => {
    const known = new Set(Array.isArray(before) ? before.map((row) => row?.id) : []);
    for (const row of rows) {
      if (row && typeof row === 'object' && !known.has(row.id) && 'actorId' in row) {
        row.actorId = actor.id;
        row.actor = actor.name;
      }
    }
  };
  for (const key of ['customers', 'tenants', 'orders', 'operating', 'rentBatches']) {
    const before = new Map((previous?.[key] || []).map((row) => [row.id, row]));
    for (const row of data[key]) {
      const prior = before.get(row.id);
      const tenantChanged = key === 'tenants' && (!prior || !isDeepStrictEqual(row, prior));
      if (key === 'orders' || key === 'tenants') {
        const accountOwner = key === 'orders' && !prior && ownerForSubscriptionOrder(row, subscriptions, previous || {}, inventory);
        if (accountOwner) {
          if (row.ownerId && row.ownerId !== accountOwner.ownerId)
            throw new LocalDataError(409, '账号归属已变化，请重新读取并核对订单归属');
          row.ownerId = accountOwner.ownerId;
          row.owner = accountOwner.ownerName;
        }
        const assign = key === 'tenants' ? assignTenantOwner : assignOrderOwner;
        const error = assign(row, prior, actor, owners);
        if (error) throw new LocalDataError(error.status, error.message);
      }
      if (!prior && (key === 'orders' || key === 'tenants' || 'createdById' in row)) {
        row.createdById = actor.id;
        row.createdBy = actor.name;
      } else if (prior && (key === 'orders' || key === 'tenants' || 'createdById' in prior)) {
        for (const field of ['createdById', 'createdBy']) {
          if (Object.hasOwn(prior, field)) row[field] = prior[field];
          else delete row[field];
        }
      }
      if (tenantChanged || ('updatedById' in row && row.version !== prior?.version)) {
        row.updatedById = actor.id;
        row.updatedBy = actor.name;
      }
      for (const list of ['refunds', 'corrections', 'bankReturns', 'items']) {
        if (Array.isArray(row[list])) attributeNew(row[list], prior?.[list]);
      }
    }
  }
  attributeNew(data.logs, previous?.logs);
}

class LocalDataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const positiveOrderAmount = (amount) => validMoney(amount) && /[1-9]/.test(amount);
const hasBankPayment = (order) => order?.payment === '银行卡' && (
  order.paidConfirmed === true || (Array.isArray(order.financialEvidence) &&
    order.financialEvidence.some((item) => item?.kind === 'payment' && item.payment === '银行卡')) ||
  (Array.isArray(order.corrections) && order.corrections.some(({ previous }) =>
    previous?.payment === '银行卡' && previous.paidConfirmed === true)));
const needsOrderCardCheck = (row, prior) => row.payment === '银行卡' &&
  (['cardId', 'tenantId', 'product', 'payment'].some(field => (row[field] || '') !== (prior?.[field] || '')) ||
    (row.paidConfirmed && !prior?.paidConfirmed && !hasBankPayment(prior) && !prior?.proCardNumber));
const usesRechargeCard = (row) =>
  (row.product === 'GPT' || personalProduct(row.product) || row.proMaterialMode === 'pool_card') &&
  typeof row.cardId === 'string' && row.cardId.startsWith('recharge:');

function orderCostSnapshot(settings) {
  const snapshot = { ...defaultOrderCosts };
  for (const key of Object.keys(snapshot)) {
    if (!Object.hasOwn(settings || {}, key)) continue;
    const value = settings[key];
    const valid = key === 'version' ? Number.isSafeInteger(value) && value > 0 :
      key === 'currency' ? ['CNY', 'MYR'].includes(value) : validMoney(value);
    if (!valid) throw new LocalDataError(400, '费用规则格式不正确，请先核对设置');
    snapshot[key] = value;
  }
  return snapshot;
}

function retainOrderField(row, prior, field) {
  if (prior && Object.hasOwn(prior, field)) row[field] = prior[field];
  else delete row[field];
}

function normalizeOrderCardType(row, prior, restorePrior, action, types) {
  delete row.cardTypeName;
  if (row.payment === '银行卡') {
    try {
      const { id, name } = cardTypeSnapshot(types, {
        cardId: row.cardId, cardTypeId: restorePrior ? restorePrior.cardTypeId : row.cardTypeId,
        prior: restorePrior || prior
      });
      if (id) {
        row.cardTypeId = id;
        row.cardTypeName = name;
      } else delete row.cardTypeId;
    } catch (error) {
      if (error.status === 400) throw new LocalDataError(400, error.message);
      throw error;
    }
  } else {
    if (row.cardTypeId !== undefined && row.cardTypeId !== '')
      throw new LocalDataError(400, '只有银行卡付款可登记银行卡类型');
    delete row.cardTypeId;
  }
  if (prior && (row.cardTypeId || '') !== (prior.cardTypeId || '') &&
      (row.version !== prior.version + 1 || (action !== '更正订单' && !restorePrior)))
    throw new LocalDataError(409, '请通过订单更正更新银行卡类型，并重新核对订单版本');
  if (!Array.isArray(row.corrections)) return;
  for (const [index, correction] of row.corrections.entries()) {
    if (!correction?.previous || typeof correction.previous !== 'object') continue;
    const original = prior?.corrections?.[index]?.previous;
    const before = original || (['更正订单', historicalFeeAction].includes(action) && correction.previous.version === prior?.version &&
      correction.versionAfter === row.version ? prior : undefined);
    for (const field of ['cardTypeId', 'cardTypeName']) retainOrderField(correction.previous, before, field);
  }
}

function checkToolbox({ version, data }) {
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(data?.shortcuts) ||
    !Array.isArray(data?.phrases)
  ) {
    throw new LocalDataError(400, '个人工具箱资料格式不正确');
  }
  if (data.shortcuts.length > 20) {
    throw new LocalDataError(400, '个人工具最多保存 20 个');
  }
  function normalizeRows(rows, validate) {
    const ids = new Set();
    return rows.map((row) => {
      if (
        typeof row?.id !== 'string' ||
        !/^[a-zA-Z0-9._-]{1,120}$/.test(row.id) ||
        ids.has(row.id)
      ) {
        throw new LocalDataError(400, '个人工具箱的资料编号无效或重复');
      }
      ids.add(row.id);
      return { id: row.id, ...validate(row) };
    });
  }
  const shortcuts = normalizeRows(data.shortcuts, (row) => {
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > 60) {
      throw new LocalDataError(400, '网址名称需为 1 至 60 字');
    }
    const url = typeof row.url === 'string' ? row.url.trim() : null;
    if (url === null || url.length > 2048) {
      throw new LocalDataError(400, '网址不能超过 2048 字');
    }
    if (url) {
      const parsed = URL.parse(url);
      if (
        !parsed ||
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) {
        throw new LocalDataError(400, '请填写不包含账号密码的 HTTP 或 HTTPS 网址');
      }
    }
    return { name, url };
  });
  const phrases = normalizeRows(data.phrases, (row) => {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (
      !title ||
      title.length > 60 ||
      !text ||
      text.length > 5000 ||
      typeof row.deleted !== 'boolean'
    ) {
      throw new LocalDataError(400, '话术需填写 1 至 60 字标题、1 至 5000 字内容及有效状态');
    }
    return { title, text, deleted: row.deleted };
  });
  return { shortcuts, phrases };
}

function openKey(databasePath) {
  if (databasePath === ':memory:') return randomBytes(32);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const keyPath = databasePath + '.key';
  try {
    if (!existsSync(databasePath)) {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  for (const path of [databasePath, keyPath]) {
    if (existsSync(path) && !lstatSync(path).isFile()) {
      throw new Error('本机数据路径必须是普通文件');
    }
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('本机数据密钥无效');
  chmodSync(keyPath, 0o600);
  return key;
}

function context(domain, version) {
  return Buffer.from(`${domain}:${version}`);
}

function encrypt(key, domain, version, text) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(context(domain, version));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key, domain, version, value) {
  const bytes = Buffer.from(value);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(context(domain, version));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
}

export function verifyBusinessDocumentPayloads(databasePath, key) {
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 4000 });
  try {
    const documents = db.prepare('SELECT domain, version, payload FROM business_document');
    for (const { domain, version, payload } of documents.iterate()) {
      const data = decrypt(key, domain, version, payload);
      if (!data || typeof data !== 'object') throw new Error('无效的业务文档');
    }
  } finally {
    db.close();
  }
}

function checkDomain(domain) {
  if (!allowedDomains.has(domain)) throw new LocalDataError(404, '没有这个本机数据模块');
}

function validCustomerOptions(tags) {
  return Array.isArray(tags) && tags.length <= 100 &&
    tags.every((tag) =>
      typeof tag === 'string' && tag === tag.trim() && tag.length > 0 &&
      tag.length <= 40 && !/[\r\n]/.test(tag)
    ) &&
    new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length;
}

function checkCustomerTagAssignments(previous, next, options) {
  const priorTags = new Map((previous?.customers ?? []).map((row) => [row.id, row.tags]));
  const configured = new Set(options);
  for (const row of next.customers) {
    const existing = priorTags.get(row.id);
    if (row.tags == null || JSON.stringify(row.tags) === JSON.stringify(existing)) continue;
    if (!Array.isArray(row.tags)) throw new LocalDataError(400, '客户标签格式不正确');
    const historical = new Set(Array.isArray(existing) ? existing : []);
    const added = row.tags.filter((tag) => !historical.has(tag));
    if (!added.length) continue;
    if (row.tags.length > 20 || new Set(row.tags).size !== row.tags.length) {
      throw new LocalDataError(400, '每位客户最多选择 20 个标签，标签不得重复');
    }
    if (added.some((tag) => !configured.has(tag))) {
      throw new LocalDataError(409, '客户标签已变化，请刷新后重新选择');
    }
  }
}

function checkWrite(entry) {
  if (!entry || typeof entry !== 'object') throw new LocalDataError(400, '保存资料格式不正确');
  const { domain, version, data, action } = entry;
  checkDomain(domain);
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new LocalDataError(400, '保存资料格式不正确');
  }
  // The local preview has no separate sign-in, so accept only the application's document shape.
  const arrayKeys = {
    inventory: inventoryLists,
    commerce: ['customers', 'tenants', 'orders', 'operating', 'rentBatches', 'logs'],
    settings: ['mailboxTypes'],
    appleBalance: ['wallets', 'allocations', 'movements', 'refunds']
  }[domain];
  if (!arrayKeys.every((name) => Array.isArray(data[name]))) {
    throw new LocalDataError(400, '本机资料结构不正确');
  }
  if (domain === 'inventory' && !validMailExtractionSettings(data.tableSettings))
    throw new LocalDataError(400, '邮箱提取用途设置格式不正确');
  if (domain === 'commerce' && 'renewalWarningDays' in data &&
      (!Number.isInteger(data.renewalWarningDays) || data.renewalWarningDays < 1 || data.renewalWarningDays > 365))
    throw new LocalDataError(400, '提前提醒天数必须是 1–365 的整数');
  if (domain === 'commerce' && 'renewalWarningHours' in data &&
      (!Number.isInteger(data.renewalWarningHours) || data.renewalWarningHours < 1 ||
        data.renewalWarningHours > 365 * 24))
    throw new LocalDataError(400, '提前提醒小时数必须是 1 至 8760 的整数');
  if (
    domain === 'settings' &&
    (!data.costSettings ||
      typeof data.costSettings !== 'object' ||
      Array.isArray(data.costSettings))
  ) {
    throw new LocalDataError(400, '费用规则格式不正确');
  }
  if (domain === 'settings' && 'customerTags' in data && !validCustomerOptions(data.customerTags)) {
    throw new LocalDataError(400, '客户标签设置格式不正确');
  }
  if (domain === 'settings' && 'customerSources' in data && !validCustomerOptions(data.customerSources)) {
    throw new LocalDataError(400, '客户来源设置格式不正确');
  }
  if (domain === 'settings' && 'orderPrices' in data && !validOrderPrices(data.orderPrices))
    throw new LocalDataError(400, '套餐售价设置格式不正确');
  if (domain === 'settings' && 'stockOrderPrices' in data && !validOrderPrices(data.stockOrderPrices))
    throw new LocalDataError(400, '成品号售价设置格式不正确');
  if (domain === 'settings' && 'applePaidPrices' in data && !validApplePaidPrices(data.applePaidPrices))
    throw new LocalDataError(400, '苹果内购代付价格式不正确');
  if (domain === 'settings' && 'gptPaidPrices' in data && !validGptPaidPrices(data.gptPaidPrices))
    throw new LocalDataError(400, 'GPT 代付价格格式不正确');
  if (domain === 'settings' && 'claudePaidPrices' in data && !validClaudePaidPrices(data.claudePaidPrices))
    throw new LocalDataError(400, 'Claude 代付价格格式不正确');
  if (domain === 'settings' && 'personalPaidPrices' in data && !validPersonalPaidPrices(data.personalPaidPrices))
    throw new LocalDataError(400, 'Gemini／Grok 代付价格格式不正确');
  if (domain === 'settings' && (('orderCurrencies' in data && !validOrderCurrencies(data.orderCurrencies)) ||
      ('orderCurrenciesByProduct' in data && !validOrderCurrencyGroups(data.orderCurrenciesByProduct))))
    throw new LocalDataError(400, '订单币种设置格式不正确');
  return {
    domain,
    version,
    data,
    action: actionsByDomain[domain].has(action) ? action : 'local_save'
  };
}

function checkWrites(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > allowedDomains.size) {
    throw new LocalDataError(400, '保存批次格式不正确');
  }
  const writes = entries.map(checkWrite);
  if (new Set(writes.map((entry) => entry.domain)).size !== writes.length) {
    throw new LocalDataError(400, '同一批次不可重复保存同一模块');
  }
  return writes;
}

function checkedRelayClaims(priorInventory, write, actor) {
  const relayError = checkRelayInventory(write.data);
  if (relayError) throw new LocalDataError(400, relayError);
  return pendingRelayClaimIds(priorInventory, write.data, { action: write.action, actor });
}

async function saveHttpWrites(store, entries, actor, verifyRelayExtraction, readOrderCards, readOrderOwners) {
  const writes = checkWrites(entries);
  const commerce = writes.find(({ domain }) => domain === 'commerce');
  const orderCards = new Map();
  if (commerce) {
    const current = store.load('commerce');
    if (current.version !== commerce.version)
      throw new LocalDataError(409, '订单已在其他页面更新，请刷新后重试');
    const previous = new Map((current.data?.orders || []).map((row) => [row.id, row]));
    const needPool = commerce.data.orders.some((row) => {
      const prior = previous.get(row.id);
      return commerce.action !== '补偿撤回更正' && usesRechargeCard(row) &&
        (needsOrderCardCheck(row, prior) || row.cardBackfillConfirmed === true);
    });
    if (needPool) {
      try {
        for (const card of await readOrderCards()) orderCards.set(card.id, card);
      } catch {
        throw new LocalDataError(503, '暂时无法核对代充卡池，草稿已保留');
      }
    }
  }
  const options = { actor, readOrderOwners, [verifiedOrderCards]: orderCards };
  const inventory = writes.find(({ domain }) => domain === 'inventory');
  if (!inventory) return store.saveBatch(writes, options);
  const current = store.load('inventory');
  if (current.version !== inventory.version) {
    throw new LocalDataError(409, '库存资料已在其他页面更新，请刷新后重试');
  }
  const locationError = checkAccountLocations(current.data, inventory.data);
  if (locationError) throw new LocalDataError(400, locationError);
  const ids = checkedRelayClaims(current.data, inventory, actor);
  if (!ids.length) return store.saveBatch(writes, options);
  const registrationError = checkRegistrationChanges(current.data, inventory.data, inventory.action, actor);
  if (registrationError) throw new LocalDataError(409, registrationError);
  if (typeof verifyRelayExtraction !== 'function') requireVerifiedRelayClaimIds(ids);
  let verifiedIds;
  try {
    verifiedIds = await verifyRelayExtraction(Object.freeze(ids), actor);
  } catch {
    throw new LocalDataError(503, '暂时无法核验苹果隐藏邮箱提取资格，请稍后重试');
  }
  requireVerifiedRelayClaimIds(ids, verifiedIds);
  return store.saveBatch(writes, { ...options, [verifiedRelayClaimIds]: verifiedIds });
}

function commerceForActor(store, snapshot, actor) {
  const profiles = store.featureDocument(subscriptionDomain).data;
  return { ...redactClaudeProOrderMaterials(snapshot, actor),
    legacyOpeningOrderIds: legacyOpeningOrderIds(snapshot.data?.orders, profiles) };
}

export function createLocalBusinessStore(databasePath) {
  const key = openKey(databasePath);
  const db = new DatabaseSync(databasePath, { timeout: 4000 });
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA busy_timeout=4000;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS business_document (
      domain TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_audit (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
  const get = db.prepare('SELECT version, payload FROM business_document WHERE domain = ?');
  const put = db.prepare(`
    INSERT INTO business_document (domain, version, payload) VALUES (?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET version=excluded.version, payload=excluded.payload
  `);
  const logStatement = db.prepare(`
    INSERT INTO business_audit (at, domain, action, summary, version) VALUES (?, ?, ?, ?, ?)
  `);
  const audit = db.prepare(
    'SELECT id, at, domain, action, summary, version FROM business_audit ORDER BY id DESC LIMIT 1000'
  );
  const revision = db.prepare('SELECT version FROM business_document WHERE domain = ?');
  const auditRevision = db.prepare('SELECT COALESCE(MAX(id), 0) AS version FROM business_audit');
  const relayRevision = db.prepare("SELECT COALESCE(MAX(id), 0) AS version FROM business_audit WHERE action IN ('relay_reset_code', 'relay_sync', 'relay_mail_reassign')");
  const changeListeners = new Set();
  const notifyChanges = () => {
    for (const listener of changeListeners) {
      try { listener(); } catch { /* Notification failures cannot undo a committed write. */ }
    }
  };
  let inTransaction = false;
  const log = { run(...values) {
    const result = logStatement.run(...values);
    if (!inTransaction) notifyChanges();
    return result;
  } };

  function readDocument(domain) {
    const row = get.get(domain);
    return row
      ? { version: row.version, data: decrypt(key, domain, row.version, row.payload) }
      : { version: 0, data: null };
  }

  function readBitBrowserDefault(scope, actor, choices) {
    const { data } = readDocument(`${bitBrowserDefaultsDomain}:${actor.id}`);
    const defaultId = data?.[bitBrowserDefaultKeys[scope]];
    return choices.some(({ id }) => id === defaultId) ? { defaultId } : {};
  }

  function writeTransaction(save) {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    let result;
    try {
      result = save();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      inTransaction = false;
    }
    notifyChanges();
    return result;
  }

  const mailboxActivity = db.prepare(`
    SELECT json_extract(summary, '$.targetId') AS id, max(at) AS at
    FROM business_audit
    WHERE domain = ? AND action = 'managed_mailbox_query' AND json_valid(summary)
    GROUP BY id
  `);

  function mailboxPoolView(snapshot) {
    const metadata = mailboxPoolMetadata(snapshot);
    const activity = new Map(mailboxActivity.all(managedMailboxDomain).map((row) => [row.id, row.at]));
    const previous = new Map(mailboxPoolItems(snapshot).map((row) => [row.id, row.lastQueriedAt]));
    return withClaudeMailboxCandidates({ ...metadata, items: metadata.items.map((row) => ({
      ...row, lastQueriedAt: activity.get(row.id) || previous.get(row.id) || null
    })) }, readDocument('inventory').data);
  }

  function commitMailboxWrite(current, body, plan, actor) {
    const { id, items, issuedCode, defaultValidDays, batch } = plan;
    if (batch && !batch.some((row) => row.success))
      return { ...mailboxPoolView(current), batch };
    const now = new Date().toISOString();
    const version = current.version + 1;
    const data = { items, defaultValidDays };
    put.run(managedMailboxDomain, version, encrypt(key, managedMailboxDomain, version, JSON.stringify(data)));
    const labels = {
      create: '登记邮箱池资料', credential: '更新邮箱授权', status: '更新邮箱状态',
      rotate: '更换邮箱查询码', settings: '保存默认查询码有效期', batch: '批量登记邮箱池资料'
    };
    log.run(now, managedMailboxDomain, `managed_mailbox_${body.action}`, auditSummary(labels[body.action], actor, id), version);
    return {
      ...mailboxPoolView({ version, data }),
      ...(issuedCode && { issuedCode }),
      ...(batch && { batch }),
      ...(body.action === 'settings' && body.applyExisting && { updatedExistingCount: items.length })
    };
  }

  return {
    tenantOwnerTransferView(tenantId) {
      return tenantOwnerTransferView(readDocument('commerce'), tenantId);
    },
    transferTenantOwner(command, actor, readOwners) {
      return writeTransaction(() => {
        const result = planTenantOwnerTransfer(readDocument('commerce'), command, actor, readOwners);
        if (result.replayed) return result;
        put.run('commerce', result.version, encrypt(key, 'commerce', result.version, JSON.stringify(result.data)));
        log.run(result.receipt.at, 'commerce', 'tenant_owner_transfer',
          auditSummary('转交租户归属', actor, command.tenantId), result.version);
        return result;
      });
    },
    load(domain) {
      checkDomain(domain);
      return readDocument(domain);
    },
    withSubscriptions(actor, operation) {
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以查看或管理订阅资料');
      return writeTransaction(() => {
        const snapshots = {
          commerce: readDocument('commerce'), inventory: readDocument('inventory'),
          mailboxes: readDocument(managedMailboxDomain), subscriptions: readDocument(subscriptionDomain)
        };
        const audit = (action, ids) => {
          const label = { view: '查看订阅资料', copy: '复制订阅资料' }[action];
          if (!label) throw new TypeError('未知订阅资料操作');
          for (const id of ids)
            log.run(new Date().toISOString(), subscriptionDomain, `subscription_${action}`,
              auditSummary(label, actor, id), snapshots.subscriptions.version);
        };
        let saved = false;
        const save = (data, action, id) => {
          const label = { subscription_owner: '设置账号归属', subscription_confirm: '确认订阅已开通' }[action];
          if (saved || !label) throw new TypeError('未知订阅资料保存');
          saved = true;
          const version = snapshots.subscriptions.version + 1;
          put.run(subscriptionDomain, version, encrypt(key, subscriptionDomain, version, JSON.stringify(data)));
          log.run(new Date().toISOString(), subscriptionDomain, action, auditSummary(label, actor, id), version);
        };
        return operation(snapshots, audit, save);
      });
    },
    withClaudeGoogleSubscriptions(actor, operation) {
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以查看或复制订阅资料');
      return writeTransaction(() => {
        const commerce = readDocument('commerce');
        const snapshots = { commerce, inventory: readDocument('inventory'), mailboxes: readDocument(managedMailboxDomain) };
        const audit = (action, orderIds) => {
          const labels = { view: '查看谷歌订阅资料', copy_1: '复制谷歌订阅资料 1', copy_2: '复制谷歌订阅资料 2' };
          const label = labels[action];
          if (!label) throw new TypeError('未知谷歌订阅资料操作');
          const now = new Date().toISOString();
          for (const id of orderIds)
            log.run(now, 'commerce', 'claude_google_subscription_' + action, auditSummary(label, actor, id), commerce.version);
        };
        return operation(snapshots, audit);
      });
    },
    loadClaudeGoogleCopySettings(actor) {
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以读取订阅复制后缀');
      const { version, data } = readDocument(claudeGoogleCopyDomainPrefix + actor.id);
      return { version, copy1: data?.copy1 || '', copy2: data?.copy2 || '' };
    },
    saveClaudeGoogleCopySettings(body, actor) {
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以保存订阅复制后缀');
      const data = validateClaudeGoogleCopySettings(body);
      return writeTransaction(() => {
        const domain = claudeGoogleCopyDomainPrefix + actor.id;
        const current = readDocument(domain);
        if (body.version !== current.version)
          throw new LocalDataError(409, '复制后缀已变化，请刷新后重新核对');
        const version = current.version + 1;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(data)));
        log.run(new Date().toISOString(), domain, 'claude_google_copy_settings',
          auditSummary('保存谷歌订阅复制后缀', actor), version);
        return { version, ...data };
      });
    },
    inventorySnapshot(actor) {
      const snapshot = readDocument('inventory');
      const commerce = readDocument('commerce');
      const review = usageReviewRows(inspectInventoryUsage(snapshot.data, commerce.data));
      if (actor?.id && snapshot.data?.mailboxes?.some(row => row?.type === 'microsoft')) {
        log.run(new Date().toISOString(), 'inventory', 'inventory_microsoft_read',
          auditSummary('读取含微软邮箱的库存资料', actor), snapshot.version);
      }
      return { ...snapshot, ...(review.length && { usageReview: review }), commerceVersion: commerce.version,
        accountSummaries: accountLifecycleSummaries(snapshot.data, commerce.data) };
    },
    saveAccountLifecycle(body, actor) {
      return writeTransaction(() => {
        const inventory = readDocument('inventory');
        const commerce = readDocument('commerce');
        const command = body?.data;
        const existing = inventory.data?.accounts?.find(account => account.id === command?.assetId)
          ?.accountLifecycleEvents?.some(event => event.id === command?.commandId);
        if (!existing && (inventory.version !== body?.version || commerce.version !== body?.commerceVersion))
          throw new LocalDataError(409, '库存或客户订单已变化，请重新打开核对');
        const now = new Date();
        const result = changeAccountLifecycle(inventory.data, commerce.data, command, actor, now);
        if (result.changed) {
          const version = inventory.version + 1;
          put.run('inventory', version, encrypt(key, 'inventory', version, JSON.stringify(inventory.data)));
          log.run(now.toISOString(), 'inventory', 'inventory_account_lifecycle',
            auditSummary(command.action === 'release' ? '恢复账号可用库存' : '账号停止复用', actor, command.assetId), version);
        }
        return this.inventorySnapshot();
      });
    },
    planAppleRelayIntake(input) {
      return planHistoricalIntake(input, readDocument('inventory'), readDocument('commerce'));
    },
    previewClaudeHistory(input) {
      return claudeHistoryPreview(planClaudeHistoryIntake(input, readDocument('inventory'), readDocument('commerce')));
    },
    saveClaudeHistory(input, actor) {
      return writeTransaction(() => {
        const current = readDocument('inventory');
        const time = new Date();
        const plan = planClaudeHistoryIntake(input, current, readDocument('commerce'), time.getTime());
        const inventory = current.data ? structuredClone(current.data) : Object.fromEntries(inventoryLists.map(key => [key, []]));
        const result = stageClaudeHistoryIntake(plan, input.inventoryVersion, inventory, actor, time);
        if (result.imported) {
          const error = checkRegistrationChanges(current.data, inventory, 'inventory_claude_history_import');
          if (error) throw new LocalDataError(409, error);
          const version = current.version + 1;
          put.run('inventory', version, encrypt(key, 'inventory', version, JSON.stringify(inventory)));
          log.run(time.toISOString(), 'inventory', 'inventory_claude_history_import',
            auditSummary('Claude 历史入库 ' + result.imported + ' 条', actor, result.batchId), version);
        }
        return { ...result, inventory: this.inventorySnapshot() };
      });
    },
    saveAppleRelayPrimaries(rows, actor, aliases = [], registration) {
      const { version, data } = readDocument('inventory');
      const history = registration?.history;
      const commerce = history && readDocument('commerce');
      if (history) requireHistoricalIntake(history, { inventoryVersion: version, commerceVersion: commerce.version });
      const inventory = data ?? Object.fromEntries(inventoryLists.map((key) => [key, []]));
      const relay = inventory.appleRelay ??= { parents: [], imports: [], events: [] };
      const { parents } = relay;
      const time = new Date().toISOString();
      const batchId = registration?.batch ? `relay-import-${randomUUID()}` : '';
      const aliasAction = history ? 'inventory_relay_history_import' : registration && !registration.batch
        ? 'inventory_relay_alias_save' : 'inventory_relay_alias_import';
      if (registration && !parents.some((row) => row.id === registration.parentId &&
          (row.version || 1) === registration.parentVersion && row.status === 'ACTIVE' && !row.deleted)) {
        throw new LocalDataError(409, '主邮箱已更新，本系统尚未入库。刷新后可按相同内容重试');
      }
      for (const { expectedVersion, imported, sourceCreatedAt, ...row } of rows) {
        const index = parents.findIndex(({ id }) => id === row.id);
        const before = parents[index];
        if (
          (before ? (before.version || 1) : null) !== expectedVersion ||
          parents.some((other) => other.id !== row.id &&
            (String(other.email || '').trim().toLowerCase() === row.email || other.remotePrimaryId === row.remotePrimaryId))
        ) throw new LocalDataError(409, '主邮箱登记资料已变化');
        const saved = {
          ...before, ...row,
          version: (expectedVersion ?? 0) + 1,
          ...(before ? {} : imported
            ? { createdAt: typeof sourceCreatedAt === 'string' ? sourceCreatedAt : '' }
            : { createdAt: time, createdById: actor.id, createdBy: actor.name }),
          updatedAt: time, lastOperatedAt: time, lastOperatedById: actor.id, lastOperatedBy: actor.name
        };
        if (index === -1) parents.unshift(saved);
        else parents[index] = saved;
      }
      for (const { expectedVersion, sourceCreatedAt, ...row } of aliases) {
        const index = inventory.mailboxes.findIndex(({ id }) => id === row.id);
        const before = inventory.mailboxes[index];
        if ((before ? (before.version || 1) : null) !== expectedVersion ||
            inventory.mailboxes.some((other) => other.id !== row.id && other.type === 'relay' &&
              (String(other.email || '').trim().toLowerCase() === row.email || other.remoteAliasId === row.remoteAliasId)))
          throw new LocalDataError(409, '隐藏邮箱登记资料已变化');
        if (history && before?.remoteAliasId === row.remoteAliasId) continue;
        const saved = before
          ? { ...before, remoteAliasId: row.remoteAliasId }
          : {
              ...row, aliasId: row.id, type: 'relay', source: '原收件服务',
              relayStatus: 'ACTIVE', health: 'normal', status: '正常',
              inventoryState: 'available', used: false, inventoryHistory: [], usageLinks: [],
              createdAt: typeof sourceCreatedAt === 'string' ? sourceCreatedAt : '', importedAt: time
            };
        if (registration && !before) Object.assign(saved, {
          source: history ? '历史入库' : 'Apple 主邮箱登记', importId: batchId,
          createdAt: time, createdById: actor.id, createdBy: actor.name,
          inventoryHistory: [{
            id: `relay-asset-event-${randomUUID()}`, action: history ? '历史入库' : '登记隐藏邮箱', detail: row.parentMailboxId,
            actorId: actor.id, actor: actor.name, time
          }]
        });
        if (registration && before) Object.assign(saved, {
          codeResetIntervalDays: row.codeResetIntervalDays, queryExpiry: row.queryExpiry,
          inventoryHistory: [...(before.inventoryHistory || []), {
            id: `relay-asset-event-${randomUUID()}`, action: '接入收件服务', detail: row.parentMailboxId,
            actorId: actor.id, actor: actor.name, time
          }]
        });
        Object.assign(saved, {
          version: (expectedVersion ?? 0) + 1, lastOperatedAt: time,
          lastOperatedById: actor.id, lastOperatedBy: actor.name
        });
        if (index === -1) inventory.mailboxes.unshift(saved);
        else inventory.mailboxes[index] = saved;
      }
      if (batchId) {
        const imports = relay.imports ??= [];
        imports.unshift({
          id: batchId, type: 'relay', types: ['relay'], parentId: registration.parentId, time,
          actor: actor.name, actorId: actor.id, total: aliases.length, success: aliases.length,
          failed: 0, status: '已登记',
          results: aliases.map(({ id, email, notes }, index) => ({
            id: `row-${index + 1}`, line: index + 1, email, note: notes, error: '', assetId: id
          }))
        });
      }
      const staged = history && stageHistoricalIntake(history, inventory, commerce.data, actor, time);
      const writes = [{ domain: 'inventory', version, data: inventory, action: registration ? aliasAction : 'inventory_relay_parent_save' }];
      if (staged?.orders.length) writes.push({
        domain: 'commerce', version: commerce.version, data: commerce.data, action: '新增独立订单'
      });
      const saved = this.saveBatch(writes, { actor, [verifiedAppleRelayPrimaries]: [
          ...rows.map(({ id }) => ({ id, action: 'inventory_relay_parent_save' })),
          ...aliases.map(({ id }) => ({ id, action: aliasAction }))
        ], ...(staged && { [stagedRelayIntake]: { ...staged, commerceVersion: commerce.version },
          [verifiedOrderCards]: new Map() }) });
      if (!staged) return saved[0];
      return {
        inventory: saved[0], processed: history.pending.length, reused: history.rows.length - history.pending.length,
        accountsCreated: staged.accountsCreated, ordersCreated: staged.orders.length
      };
    },
    saveInventoryUsageCorrection(body, actor) {
      if (actor && !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以更正库存使用关联');
      const operator = actor ?? localToolboxActor;
      const { assetId, linkIndex, reason } = body.data || {};
      if (!Number.isSafeInteger(body.version) || body.version < 0 ||
        typeof assetId !== 'string' || !assetId ||
        !Number.isSafeInteger(linkIndex) || linkIndex < 0 ||
        typeof reason !== 'string' || !reason.trim() || reason.trim().length > 300)
        throw new LocalDataError(400, '请填写有效的更正理由并重新核对原关联');
      return writeTransaction(() => {
        const snapshot = readDocument('inventory');
        if (!snapshot.data || snapshot.version !== body.version)
          throw new LocalDataError(409, '库存已变化，请重新打开详情后更正');
        const commerce = readDocument('commerce').data;
        const now = new Date();
        if (!correctInventoryUsage(snapshot.data, commerce, assetId, linkIndex, reason.trim(), operator, now))
          throw new LocalDataError(409, '该记录不是可更正的自动关联，或已经更正');
        const version = snapshot.version + 1;
        put.run('inventory', version, encrypt(key, 'inventory', version, JSON.stringify(snapshot.data)));
        log.run(now.toISOString(), 'inventory', 'inventory_usage_correction',
          auditSummary('更正库存使用关联', operator, assetId), version);
        const usageReview = usageReviewRows(inspectInventoryUsage(snapshot.data, commerce, now.getTime()));
        return { version, data: snapshot.data, usageReview,
          commerceVersion: readDocument('commerce').version,
          accountSummaries: accountLifecycleSummaries(snapshot.data, commerce) };
      });
    },
    appendWebsiteVisit(event, time) {
      return writeTransaction(() => {
        const current = readDocument(websiteVisitsDomain);
        const rows = appendWebsiteVisit(current.data || [], event, time);
        if (rows) {
          const version = current.version + 1;
          put.run(websiteVisitsDomain, version, encrypt(key, websiteVisitsDomain, version, JSON.stringify(rows)));
        }
      });
    },
    searchWebsiteVisits(input, time) {
      return reportWebsiteVisits(readDocument(websiteVisitsDomain).data || [], input, time);
    },
    revealWebsiteVisit(id, time, actor) {
      const snapshot = readDocument(websiteVisitsDomain);
      const result = getWebsiteVisitIp(snapshot.data || [], id, time);
      log.run(new Date(time).toISOString(), websiteVisitsDomain, 'website_visit_reveal',
        auditSummary('查看网站访问 IP', actor, id), snapshot.version);
      return result;
    },
    loadWebsiteVisitBackup() {
      const snapshot = readDocument(websiteVisitsDomain);
      return { version: snapshot.version, count: snapshot.data?.length ?? 0 };
    },
    loadManagedMailboxPool() {
      return mailboxPoolView(readDocument(managedMailboxDomain));
    },
    importLegacyManagedMailboxPool(bundle, secrets, expectedVersion) {
      return writeTransaction(() => {
        const current = readDocument(managedMailboxDomain);
        if (current.version !== expectedVersion)
          throw new MailboxPoolError(409, '邮箱池版本已变化，请重新核对目标');
        const { items, defaultValidDays, imported, unchanged } = planLegacyMailboxImport(current, bundle, secrets);
        if (!imported) return { version: current.version, imported, unchanged };
        const version = current.version + 1;
        const data = { items, defaultValidDays };
        put.run(managedMailboxDomain, version, encrypt(key, managedMailboxDomain, version, JSON.stringify(data)));
        log.run(new Date().toISOString(), managedMailboxDomain, 'managed_mailbox_legacy_import',
          auditSummary(`导入旧邮箱池 ${imported} 条`, localToolboxActor), version);
        return { version, imported, unchanged };
      });
    },
    saveManagedMailboxPool(body, actor, microsoftRefreshToken) {
      return writeTransaction(() => {
        const current = readDocument(managedMailboxDomain);
        const plan = applyMailboxPoolWrite(current, body, Date.now(), microsoftRefreshToken);
        return commitMailboxWrite(current, body, plan, actor);
      });
    },
    async saveVerifiedManagedMailboxPool(body, actor, verify) {
      const before = readDocument(managedMailboxDomain);
      const plan = await prepareVerifiedMailboxWrite(before, body, verify);
      return writeTransaction(() => {
        const current = readDocument(managedMailboxDomain);
        if (current.version !== before.version) throw new MailboxPoolError(409, '邮箱池已更新，请重新读取');
        return commitMailboxWrite(current, body, plan, actor);
      });
    },
    copyManagedMailboxCode(id, actor) {
      const current = readDocument(managedMailboxDomain);
      const code = mailboxPoolItems(current).find((row) => row.id === id)?.queryCode;
      if (!code) throw new MailboxPoolError(404, '查询码无法读取，可重新生成');
      log.run(new Date().toISOString(), managedMailboxDomain, 'managed_mailbox_code_read',
        auditSummary('读取买家查询码', actor, id), current.version);
      return { code };
    },
    readManagedMailboxCodePage(page, actor) {
      return writeTransaction(() => {
        const result = mailboxPoolCodePage(readDocument(managedMailboxDomain), page);
        const at = new Date().toISOString();
        for (const { id, code } of result.items) {
          if (code) log.run(at, managedMailboxDomain, 'managed_mailbox_code_read',
            auditSummary('读取买家查询码', actor, id), result.version);
        }
        return result;
      });
    },
    markManagedMailboxAuthFailed(id, expectedVersion) {
      return writeTransaction(() => {
        const current = readDocument(managedMailboxDomain);
        if (current.version !== expectedVersion) return;
        const items = mailboxPoolItems(current);
        if (!items.some((row) => row.id === id && !row.authFailed)) return;
        const now = new Date().toISOString();
        const version = current.version + 1;
        const data = {
          defaultValidDays: current.data?.defaultValidDays ?? 7,
          items: items.map((row) => row.id === id ? { ...row, authFailed: true, updatedAt: now } : row)
        };
        put.run(managedMailboxDomain, version, encrypt(key, managedMailboxDomain, version, JSON.stringify(data)));
        log.run(now, managedMailboxDomain, 'managed_mailbox_auth_failed', '收信服务拒绝邮箱授权', version);
      });
    },
    findManagedMailbox(code, clock) {
      return findMailboxQuery(readDocument(managedMailboxDomain), code, clock);
    },
    rotateMicrosoftRefreshToken(id, expectedVersion, refreshToken) {
      return writeTransaction(() => {
        const current = readDocument(managedMailboxDomain);
        if (current.version !== expectedVersion) return false;
        const items = mailboxPoolItems(current);
        if (!items.some((row) => row.id === id && row.provider === 'microsoft')) return false;
        const version = current.version + 1;
        const updated = { items: items.map((row) => row.id === id ? { ...row, refreshToken } : row),
          defaultValidDays: current.data?.defaultValidDays ?? 7 };
        put.run(managedMailboxDomain, version, encrypt(key, managedMailboxDomain, version, JSON.stringify(updated)));
        return true;
      });
    },
    recordManagedMailboxQuery(id) {
      log.run(new Date().toISOString(), managedMailboxDomain, 'managed_mailbox_query',
        JSON.stringify({ label: '邮箱查询成功', targetId: id }), 0);
    },
    loadSavedTotp(actor) {
      return savedTotpMetadata(readDocument(`${savedTotpDomain}:${actor.id}`));
    },
    revealSavedTotp(body, actor) {
      return revealSavedTotpSecret(body, actor, {
        readSnapshot: readDocument,
        recordView: (id, version) => log.run(new Date().toISOString(), savedTotpDomain, 'saved_totp_view',
          auditSummary('查看 2FA 密钥', actor, id), version)
      });
    },
    async importLegacySavedTotp(bundle, secrets, actor, expectedVersion) {
      const domain = `${savedTotpDomain}:${actor.id}`;
      const before = readDocument(domain);
      if (before.version !== expectedVersion)
        throw new SavedTotpError(409, '2FA 账号已更新，请重新核对');
      const { items, imported, unchanged } = await planLegacyTotpImport(before, bundle, secrets);
      return writeTransaction(() => {
        if (readDocument(domain).version !== before.version)
          throw new SavedTotpError(409, '2FA 账号已更新，请重新核对');
        if (!imported) return { version: before.version, imported, unchanged, total: items.length };
        const version = before.version + 1;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(items)));
        log.run(new Date().toISOString(), savedTotpDomain, 'saved_totp_legacy_import',
          auditSummary(`导入旧 2FA 账号 ${imported} 条`, actor), version);
        return { version, imported, unchanged, total: items.length };
      });
    },
    async saveSavedTotp(body, actor) {
      const command = await validateTotpWrite(body);
      const domain = `${savedTotpDomain}:${actor.id}`;
      return writeTransaction(() => {
        const now = new Date().toISOString();
        const current = readDocument(domain);
        const { id, items } = applyTotpWrite(current, command, now);
        const version = current.version + 1;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(items)));
        const labels = { create: '新增 2FA 账号', update: '修改 2FA 账号', delete: '删除 2FA 账号' };
        log.run(now, savedTotpDomain, `saved_totp_${command.action}`,
          auditSummary(labels[command.action], actor, id), version);
        return savedTotpMetadata({ version, data: items });
      });
    },
    async useSavedTotp(id, actor) {
      const snapshot = readDocument(`${savedTotpDomain}:${actor.id}`);
      const result = await generateSavedCode(snapshot, id);
      if (readDocument(`${savedTotpDomain}:${actor.id}`).version !== snapshot.version)
        throw new SavedTotpError(409, '账号已更新，请重新获取验证码');
      log.run(new Date().toISOString(), savedTotpDomain, 'saved_totp_use',
        auditSummary('查看 2FA 验证码', actor, id), snapshot.version);
      return result;
    },
    async readSavedTotpCodePage(page, actor) {
      const domain = `${savedTotpDomain}:${actor.id}`;
      const result = await generateSavedCodePage(readDocument(domain), page);
      return writeTransaction(() => {
        if ((revision.get(domain)?.version ?? 0) !== result.version)
          throw new SavedTotpError(409, '账号列表已更新，请刷新列表');
        const at = new Date().toISOString();
        for (const { id, code } of result.items) {
          if (code) log.run(at, savedTotpDomain, 'saved_totp_use',
            auditSummary('查看 2FA 验证码', actor, id), result.version);
        }
        return result;
      });
    },
    loadToolbox(actor = localToolboxActor) {
      const { version, data } = readDocument(`toolbox:${actor.id}`);
      return { version, data: data ?? { shortcuts: [], phrases: [] } };
    },
    saveToolbox(body, actor = localToolboxActor) {
      const data = checkToolbox(body);
      const domain = `toolbox:${actor.id}`;
      return writeTransaction(() => {
        const current = readDocument(domain);
        if (current.version !== body.version) {
          throw new LocalDataError(409, '个人工具箱已在其他页面更新，请刷新后重试');
        }
        const ids = new Set(data.phrases.map((row) => row.id));
        if (current.data?.phrases.some((row) => !ids.has(row.id))) {
          throw new LocalDataError(400, '已保存的话术只能软删除');
        }
        const previous = new Map((current.data?.phrases || []).map((row) => [row.id, row]));
        const now = new Date().toISOString();
        for (const row of data.phrases) {
          const before = previous.get(row.id);
          if (!before || row.title !== before.title || row.text !== before.text || row.deleted !== before.deleted)
            row.updatedAt = now;
          else if (before.updatedAt) row.updatedAt = before.updatedAt;
        }
        const version = current.version + 1;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(data)));
        log.run(
          new Date().toISOString(),
          'toolbox',
          'toolbox_save',
          auditSummary('保存个人工具箱', actor),
          version
        );
        return { version, data };
      });
    },
    loadBitBrowserConnections(actor = localToolboxActor) {
      const { version, data } = readDocument(`${bitBrowserConnectionDomain}:${actor.id}`);
      const profiles = summarizeBitBrowserConnections(data ?? []);
      return { version, profiles, ...readBitBrowserDefault(bitBrowserConnectionDomain, actor, profiles) };
    },
    loadBitBrowserDefaults(actor) {
      return readDocument(`${bitBrowserDefaultsDomain}:${actor.id}`);
    },
    saveBitBrowserDefault(scope, body, actor) {
      if (!actor?.id) throw new LocalDataError(401, '请先登录');
      const field = bitBrowserDefaultKeys[scope];
      if (!Object.hasOwn(bitBrowserDefaultKeys, scope) || !body || Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, 'defaultId') || (body.defaultId !== null && typeof body.defaultId !== 'string'))
        throw new LocalDataError(400, '默认选项无效');
      const { defaultId } = body;
      const domain = `${bitBrowserDefaultsDomain}:${actor.id}`;
      return writeTransaction(() => {
        const current = readDocument(domain);
        const { data: choices } = readDocument(`${scope}:${actor.id}`);
        if (defaultId !== null && !choices?.some(({ id }) => id === defaultId))
          throw new LocalDataError(404, '该选项不在你的资料中，请刷新后重试');
        if ((current.data?.[field] ?? null) === defaultId) return { defaultId };
        const version = current.version + 1;
        const data = { ...current.data, [field]: defaultId };
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(data)));
        log.run(new Date().toISOString(), bitBrowserDefaultsDomain, 'bitbrowser_default_save',
          auditSummary(field === 'connectionId' ? '修改个人默认比特账号' : '修改个人默认执行 IP', actor, defaultId),
          version);
        return { defaultId };
      });
    },
    useBitBrowserConnectionSecrets(body, actor) {
      const domain = `${bitBrowserConnectionDomain}:${actor.id}`;
      return readBitBrowserConnectionSecrets(readDocument(domain), body, (id, sealed) =>
        decrypt(key, `${domain}:static-proxy:${id}`, 1, Buffer.from(sealed, 'base64url'))
      );
    },
    saveBitBrowserConnection(body, actor = localToolboxActor) {
      const command = validateBitBrowserConnectionWrite(body);
      const domain = `${bitBrowserConnectionDomain}:${actor.id}`;
      return writeTransaction(() => {
        // Older versions expose extra profile fields in summaries, so proxy secrets must remain sealed there.
        const result = writeBitBrowserConnection(readDocument(domain), command, (id, credentials) =>
          encrypt(key, `${domain}:static-proxy:${id}`, 1, JSON.stringify(credentials)).toString('base64url')
        );
        const { version, profiles, savedId } = result;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(profiles)));
        log.run(
          new Date().toISOString(),
          bitBrowserConnectionDomain,
          command.profile.id ? 'bitbrowser_connection_update' : 'bitbrowser_connection_create',
          auditSummary(command.profile.id ? '修改比特连接配置' : '保存比特连接配置', actor, savedId),
          version
        );
        return { version, profiles: summarizeBitBrowserConnections(profiles), savedId,
          ...readBitBrowserDefault(bitBrowserConnectionDomain, actor, profiles) };
      });
    },
    loadBitBrowserWindow(body, actor) {
      return { record: readWindowRecord(readDocument(`${bitBrowserWindowDomain}:${actor.id}`).data, body) };
    },
    saveBitBrowserWindow(body, actor) {
      const domain = `${bitBrowserWindowDomain}:${actor.id}`;
      return writeTransaction(() => {
        const current = readDocument(domain);
        const { record, rows } = writeWindowRecord(current.data, body);
        const version = current.version + 1;
        put.run(domain, version, encrypt(key, domain, version, JSON.stringify(rows)));
        log.run(new Date().toISOString(), bitBrowserWindowDomain, 'bitbrowser_window_save',
          auditSummary('保存比特原窗口关联', actor, record.sourceJobId), version);
        return { record };
      });
    },
    loadBitBrowserProxies(actor) {
      const { version, data } = readDocument(`${bitBrowserProxyDomain}:${actor.id}`);
      const items = summarizeBitBrowserProxies(data ?? []);
      return { version, items, ...readBitBrowserDefault(bitBrowserProxyDomain, actor, items) };
    },
    useBitBrowserProxy(body, actor) {
      return writeTransaction(() => {
        const proxy = readBitBrowserProxy(readDocument(`${bitBrowserProxyDomain}:${actor.id}`), body);
        log.run(new Date().toISOString(), bitBrowserProxyDomain, 'bitbrowser_proxy_access',
          auditSummary('取用比特执行 IP', actor, proxy.id), body.version);
        return proxy;
      });
    },
    saveBitBrowserProxy(body, actor) {
      const domain = `${bitBrowserProxyDomain}:${actor.id}`;
      return writeTransaction(() => {
        const current = readDocument(domain);
        const previous = current.data?.find(item => item.id === body?.id);
        const { version, proxy } = validateBitBrowserProxyWrite(body, previous);
        if (version !== current.version) throw new BitBrowserConnectionError(409, 'IP 列表已更新，请核对最新资料，输入已保留');
        if (!previous && (current.data?.length ?? 0) >= 500) throw new BitBrowserConnectionError(400, '个人 IP 列表最多保存 500 条');
        const items = previous ? current.data.map(item => item.id === proxy.id ? proxy : item) : [...(current.data ?? []), proxy];
        put.run(domain, version + 1, encrypt(key, domain, version + 1, JSON.stringify(items)));
        log.run(new Date().toISOString(), bitBrowserProxyDomain, previous ? 'bitbrowser_proxy_update' : 'bitbrowser_proxy_create',
          auditSummary('保存比特执行 IP', actor, proxy.id), version + 1);
        return { version: version + 1, items: summarizeBitBrowserProxies(items), savedId: proxy.id,
          ...readBitBrowserDefault(bitBrowserProxyDomain, actor, items) };
      });
    },
    listBitBrowserAddresses(search, actor = localToolboxActor) {
      const { version, data } = readDocument(`${bitBrowserAddressDomain}:${actor.id}`);
      return { ...listBitBrowserAddresses(data ?? [], search), version };
    },
    loadBitBrowserAddressBackup(domain) {
      const prefix = `${bitBrowserAddressDomain}:`;
      const owner = domain.startsWith(prefix) ? domain.slice(prefix.length) : '';
      if (owner !== localToolboxActor.id && !isBitBrowserAddressId(owner)) {
        throw new LocalDataError(404, '地址资料文档编号无效');
      }
      const snapshot = readDocument(domain);
      if (!Array.isArray(snapshot.data)) throw new LocalDataError(404, '找不到地址资料文档');
      return snapshot;
    },
    saveBitBrowserAddresses(body, actor = localToolboxActor) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new LocalDataError(400, '地址操作格式不正确');
      }
      const importing = Object.hasOwn(body, 'streets');
      const generating = Object.hasOwn(body, 'count');
      const deleting = Object.hasOwn(body, 'deleteUsed');
      const keys = importing ? ['streets']
        : generating ? ['count']
          : deleting ? ['deleteUsed', 'version'] : ['id', 'status', 'expectedStatus'];
      if (
        Object.keys(body).length !== keys.length ||
        !keys.every((key) => Object.hasOwn(body, key))
      ) {
        throw new LocalDataError(400, '地址操作格式不正确');
      }
      const domain = `${bitBrowserAddressDomain}:${actor.id}`;
      return writeTransaction(() => {
        const current = readDocument(domain);
        const previous = current.data ?? [];
        const now = new Date().toISOString();
        let write;
        let action;
        let label;
        if (importing) {
          write = importBitBrowserAddresses(previous, body.streets, now);
          const { imported, duplicated, rejected } = write.result;
          action = 'bitbrowser_address_import';
          label = `批量导入比特地址，新增 ${imported} 条，重复 ${duplicated} 条，无效 ${rejected} 条`;
        } else if (generating) {
          write = generateBitBrowserAddresses(previous, body.count, now);
          action = 'bitbrowser_address_generate';
          label = `生成比特账单地址 ${write.result.count} 条`;
        } else if (deleting) {
          write = deleteUsedBitBrowserAddresses(previous, body, current.version);
          action = 'bitbrowser_address_delete_used';
          label = `删除已使用比特地址 ${write.result.deleted} 条`;
        } else {
          write = updateBitBrowserAddress(previous, body, now);
          action = 'bitbrowser_address_status';
          label = '标记比特地址已使用';
        }
        const { rows, result } = write;
        if (rows === previous && !importing) return result;
        let version = current.version;
        if (rows !== previous) {
          version++;
          put.run(domain, version, encrypt(key, domain, version, JSON.stringify(rows)));
        }
        log.run(
          now,
          bitBrowserAddressDomain,
          action,
          auditSummary(label, actor, result.id),
          version
        );
        return result;
      });
    },
    saveBatch(entries, {
      actor, verifyAutomaticSnapshot, readOrderOwners, [verifiedRelayClaimIds]: verifiedIds,
      [verifiedAppleRelayPrimaries]: primaryTargets, [verifiedOrderCards]: cards, [stagedRelayIntake]: relayIntake
    } = {}) {
      // Initial cards are transient input: preserve the caller's retry snapshot on rollback.
      const writes = checkWrites(entries).map(write => (write.domain === 'commerce' &&
        write.data.tenants.some(row => Object.hasOwn(row, 'initialCards'))) ||
        (write.domain === 'inventory' && write.data.mailboxes.some(row => Object.hasOwn(row, 'appleOpeningBalance'))) ||
        (write.domain === 'appleBalance' && write.action === 'apple_topup')
        ? { ...write, data: structuredClone(write.data) } : write);
      return writeTransaction(() => {
        if (relayIntake && (get.get('commerce')?.version ?? 0) !== relayIntake.commerceVersion)
          throw new LocalDataError(409, '订单或客户资料已变化，请重新预检');
        for (const { domain, version } of writes) {
          if ((get.get(domain)?.version ?? 0) !== version) {
            throw new LocalDataError(
              409,
              `${domainLabels[domain]}资料已在其他页面更新，请刷新后重试`
            );
          }
        }
        const current = (domain) => readDocument(domain).data;
        const settings = writes.find(({ domain }) => domain === 'settings');
        if (settings) {
          const savedSettings = current('settings');
          settings.data = retainOrderSettings(settings.data, savedSettings);
          for (const key of ['customerTags', 'customerSources', 'orderPrices', 'stockOrderPrices', 'gptPaidPrices', 'claudePaidPrices', 'applePaidPrices']) {
            if (!Object.hasOwn(settings.data, key) && savedSettings && Object.hasOwn(savedSettings, key)) {
              settings.data = { ...settings.data, [key]: savedSettings[key] };
            }
          }
        }
        const incoming = new Map(writes.map(({ domain, data }) => [domain, data]));
        const checksStock = incoming.has('inventory') || incoming.has('commerce');
        const priorInventory = checksStock ? current('inventory') : null;
        const priorCommerce = checksStock ? current('commerce') : null;
        let inventory = incoming.get('inventory') ?? priorInventory;
        const commerce = incoming.get('commerce') ?? priorCommerce;
        const inventoryWrite = writes.find(({ domain }) => domain === 'inventory');
        const priorUsage = checksStock ? inspectInventoryUsage(priorInventory, priorCommerce) : null;
        const returnedBatches = new Set();
        let isolatedHistoricalOrderCorrection = false;
        if (inventoryWrite) {
          const write = inventoryWrite;
          if (write.action === 'inventory_reconcile_usage') {
            if (!priorInventory || writes.length !== 1)
              throw new LocalDataError(409, '请单独核对当前库存使用关联');
            inventory = write.data = structuredClone(priorInventory);
          }
          const ids = checkedRelayClaims(priorInventory, write, actor);
          requireVerifiedRelayClaimIds(ids, verifiedIds);
          const relayParents = inventory.appleRelay?.parents ?? [];
          const existingParents = priorInventory?.appleRelay?.parents ?? [];
          const links = (rows) => new Map(rows.filter((row) => row.remotePrimaryId)
            .map(({ id, remotePrimaryId, email }) => [id, { remotePrimaryId, email }]));
          const aliasLinks = (rows) => new Map(rows.filter((row) => row.remoteAliasId)
            .map(({ id, remoteAliasId, email, parentMailboxId, type }) =>
              [id, { remoteAliasId, email, parentMailboxId, type }]));
          if (relayParents.some((row) => Object.hasOwn(row, 'appPassword')) ||
              (!primaryTargets && (!isDeepStrictEqual(links(relayParents), links(existingParents)) ||
                !isDeepStrictEqual(aliasLinks(inventory.mailboxes), aliasLinks(priorInventory?.mailboxes ?? []))))) {
            throw new LocalDataError(409, '请通过主邮箱授权入口修改收件连接');
          }
          const entryError = checkInventoryEntryFields(priorInventory, inventory, write.action);
          if (entryError) throw new LocalDataError(400, entryError);
          const personalEntryError = preparePersonalInventory(priorInventory, inventory, write.action, actor, new Date(), priorUsage);
          if (personalEntryError) throw new LocalDataError(409, personalEntryError);
          const platformError = prepareMailboxPlatformMarks(priorInventory, inventory, write.action, actor);
          if (platformError) throw new LocalDataError(409, platformError);
          const attributionError = attributeInventory(priorInventory, inventory, actor, write.action);
          if (attributionError) throw new LocalDataError(409, attributionError);
          defaultInventoryRegistrationTimes(priorInventory, inventory);
          const historyError = checkInventoryHistory(priorInventory, inventory);
          if (historyError) throw new LocalDataError(409, historyError);
          const registrationError = checkRegistrationChanges(priorInventory, inventory, write.action, actor);
          if (registrationError) throw new LocalDataError(409, registrationError);
          const existingUsage = incoming.has('commerce')
            ? inspectInventoryUsage(priorInventory, commerce) : new Map(priorUsage);
          if (priorInventory && write.action === 'inventory_return') {
            const currentEvidence = { ...priorInventory, accounts: inventory.accounts,
              registrationRecords: inventory.registrationRecords };
            for (const [id, match] of inspectInventoryUsage(currentEvidence, commerce))
              existingUsage.set(id, match);
          }
          const nextAssets = new Map([...inventory.mailboxes, ...inventory.accounts].map((row) => [row?.id, row]));
          for (const { asset, claim } of existingUsage.values()) {
            const next = nextAssets.get(asset.id);
            const nextState = next?.inventoryState || (next?.used ? 'used' : 'available');
            if (!next || next.email !== asset.email || next.type !== asset.type ||
              (asset.inventoryState === 'claimed' &&
                (next.claimId !== asset.claimId || nextState === 'available')) ||
              (asset.inventoryState !== 'claimed' && nextState === 'claimed') ||
              (claim && write.action === 'inventory_order_sale' && nextState === 'used' &&
                priorUsage.has(asset.id))) {
              throw new LocalDataError(409, '存在账号、订单或待核对的使用关联，请刷新后重新核对库存');
            }
          }
          if (write.action === 'inventory_return') {
            const pending = new Set((priorInventory?.batches || []).flatMap((batch) =>
              (batch?.items || []).filter((item) => item?.status === 'pending').map((item) => item.id)
            ));
            for (const batch of inventory.batches || []) {
              if ((batch?.items || []).some((item) =>
                pending.has(item?.id) && ['returned', 'abnormal'].includes(item.status)))
                returnedBatches.add(batch.id);
            }
          }
        }
        if (incoming.has('commerce')) {
          if (!('renewalWarningHours' in commerce) && priorCommerce?.renewalWarningHours !== undefined)
            commerce.renewalWarningHours = priorCommerce.renewalWarningHours;
          if ('renewalWarningHours' in commerce) delete commerce.renewalWarningDays;
          else if (!('renewalWarningDays' in commerce) && priorCommerce?.renewalWarningDays !== undefined)
            commerce.renewalWarningDays = priorCommerce.renewalWarningDays;
          const { action } = writes.find((write) => write.domain === 'commerce');
          const subscriptions = current(subscriptionDomain);
          const checkedAt = Date.now();
          const legacyOpening = action === tenantRenewalHandledAction
            ? new Set(legacyOpeningOrderIds(priorCommerce?.orders, subscriptions)) : undefined;
          try { prepareTenantRenewalWrite(priorCommerce, commerce, action, actor, new Date(checkedAt), legacyOpening); }
          catch (error) { throw new LocalDataError(error.status || 400, error.message); }
          checkCustomerTagAssignments(
            priorCommerce, commerce, (incoming.get('settings') ?? current('settings'))?.customerTags
          );
          const renewalError = checkInventoryRenewals(priorCommerce, commerce, inventory);
          if (renewalError) throw new LocalDataError(409, renewalError);
          if (actor) {
            let owners = [];
            try { owners = readOrderOwners?.() || []; }
            catch { throw new LocalDataError(503, '暂时无法核对归属人，请稍后重试'); }
            attributeCommerce(commerce, priorCommerce, actor, owners, subscriptions, inventory);
          } else checkTenantTransferHistory(commerce.tenants, priorCommerce?.tenants);
          if (action === historicalFeeAction && (writes.length !== 1 || !actor?.id ||
              !['admin', 'super'].includes(actor.role)))
            throw new LocalDataError(403, '历史费率更正须由管理员单独核对');
          const oldOrders = priorCommerce?.orders || [];
          const priorById = new Map(oldOrders.map((row) => [row.id, row]));
          const nextById = new Map(commerce.orders.map((row) => [row.id, row]));
          const cardBackfillRequests = commerce.orders.filter(row => Object.hasOwn(row, 'cardBackfillConfirmed'));
          const changedOrderCount = commerce.orders.filter(row => !isDeepStrictEqual(row, priorById.get(row.id))).length +
            oldOrders.filter(row => !nextById.has(row.id)).length + Number(nextById.size !== commerce.orders.length);
          if (cardBackfillRequests.length && (writes.length !== 1 || cardBackfillRequests.length !== 1 ||
              [...new Set([...Object.keys(priorCommerce || {}), ...Object.keys(commerce)])].some(key =>
                !['orders', 'logs'].includes(key) && !isDeepStrictEqual(priorCommerce?.[key], commerce[key]))))
            throw new LocalDataError(409, '原付款卡补录须单独进行，请保留其他资料');
          if (cardBackfillRequests.length && (!actor?.id || !['admin', 'super'].includes(actor.role)))
            throw new LocalDataError(403, '原付款卡补录须由管理员核对');
          if (!cards && cardBackfillRequests.length)
            throw new LocalDataError(503, '暂时无法核对原付款卡，请稍后重试');
          let verifiedCardBackfillId;
          let cardTypes;
          for (const row of commerce.orders) {
            const prior = priorById.get(row.id);
            if (prior && isDeepStrictEqual(row, prior)) continue;
            const terminationError = checkSubscriptionTermination(row, prior, action, checkedAt, !cards);
            if (terminationError) throw new LocalDataError(409, terminationError);
            if (cards && !prior && action === '新增独立订单' && row.source === '管理员手工') {
              if (row.draft || row.cancelled || ['draft', 'failed', '草稿', '失败'].includes(row.status) ||
                  row.paidConfirmed !== true || row.receiptConfirmed !== true || !positiveOrderAmount(row.paidAmount) ||
                  !validMoney(row.saleAmount) || !validCurrencyCode(row.paidCurrency) || !validCurrencyCode(row.saleCurrency))
                throw new LocalDataError(400, '请填写本单实际代付、客户实收及币种后确认提交');
              if (!(subscriptionTime(row.expiry) > subscriptionTime(row.start)))
                throw new LocalDataError(400, '请填写有效的订阅起止时间');
              if (!commerce.customers.some(customer => customer.id === row.customerId && customer.active !== false))
                throw new LocalDataError(400, '请选择订单客户');
              row.entitlementStatus = 'active';
            } else if (cards && !personalProduct(row.product) && row.source !== '线上代充' && prior?.source !== '线上代充') {
              retainOrderField(row, prior, 'entitlementStatus');
            }
            if (personalProduct(row.product) || personalProduct(prior?.product)) {
              if (prior && prior.product !== row.product) throw new LocalDataError(409, '原订单产品不可更换');
              const issue = personalOrderError(row, prior, commerce.orders, commerce.customers);
              if (issue) throw new LocalDataError(400, issue);
              if (!prior) {
                const entryIssue = checkNewOrder(row);
                if (entryIssue) throw new LocalDataError(400, entryIssue);
              }
            }
            const lastCorrection = prior?.corrections?.at(-1);
            const restorePrior = action === '补偿撤回更正' && lastCorrection?.versionAfter === prior?.version
              ? lastCorrection?.previous : undefined;
            // HTTP writes always supply the verified card map. Internal imports may contain historical Pro rows.
            const compatibility = { allowLegacyCreate: !cards && !prior };
            const materialError = normalizeClaudeProMaterials(row, restorePrior || prior, compatibility) ||
              normalizeClaudeCertification(row, restorePrior || prior, commerce.tenants, compatibility);
            if (materialError) throw new LocalDataError(400, materialError);
            if (hasBankPayment(prior) && row.payment !== prior.payment)
              throw new LocalDataError(409, '已确认银行卡付款的原订单不可更换支付方式');
            if (cardTypes === undefined) cardTypes = current(cardTypeDocument);
            if (action === historicalFeeAction || row.cardBackfillConfirmed === true) {
              retainOrderField(row, prior, 'cardTypeId');
              retainOrderField(row, prior, 'cardTypeName');
            } else normalizeOrderCardType(row, prior, restorePrior, action, cardTypes);
            const historyError = checkClaudeProMaterialHistory(row, prior, action) ||
              checkClaudeProRenewalSource(row, prior, priorById, nextById, compatibility);
            if (historyError) throw new LocalDataError(409, historyError);
          }
          if (cards) {
            const nextIds = new Set(commerce.orders.map(({ id }) => id));
            if (oldOrders.some((row) => row.source === '线上代充' && !nextIds.has(row.id)))
              throw new LocalDataError(409, '请使用既有业务撤单流程处理代充订单');
            const seen = [...oldOrders];
            const settledThisWrite = [];
            const tenantCards = current('tenant-cards')?.items || [];
            const freezes = current(cardFreezeDocument);
            for (const row of commerce.orders) {
              const prior = priorById.get(row.id);
              if (prior && isDeepStrictEqual(row, prior)) continue;
              const automatic = prior?.source === '线上代充';
              if ((!automatic && row.source === '线上代充') || (row.taskId ?? '') !== (prior?.taskId ?? '') ||
                  (automatic && rechargeEvidenceFields.filter(field =>
                    !['更正订单', '补偿撤回更正'].includes(action) || !['cardId', 'paymentId'].includes(field)).some((field) =>
                    !isDeepStrictEqual(prior[field] ?? '', row[field] ?? ''))))
                throw new LocalDataError(409, '线上代充来源只能由服务端登记');
              if (prior) {
                for (const field of ['orderNo', 'createdAt', 'cardUsedAt', 'issueFeeSnapshot',
                  ...(action === historicalFeeAction ? [] : ['costSettings'])])
                  retainOrderField(row, prior, field);
                if (automatic) {
                  if (row.customerId === prior.customerId) retainOrderField(row, prior, 'customerSource');
                  else {
                    const source = commerce.customers.find((customer) => customer.id === row.customerId)?.source;
                    if (source) row.customerSource = source;
                    else delete row.customerSource;
                  }
                }
                if (prior.product && row.product !== prior.product)
                  throw new LocalDataError(409, '原订单产品不可更换');
              }
              if (prior && row.costBasis === 'actual' &&
                  ['costBasis', 'actualCostAmount', 'actualCostCurrency', 'appleRecoverableCostAmount']
                    .some((field) => (prior[field] ?? '') !== (row[field] ?? ''))) {
                const correction = row.corrections?.at(-1);
                if (action !== '更正订单' || typeof correction?.reason !== 'string' ||
                    !correction.reason.trim() || correction.previous?.version !== prior.version)
                  throw new LocalDataError(400, '实际总成本需要有依据的订单更正记录');
              }
              if (!prior) {
                if (!row.product || !['银行卡', '苹果内购'].includes(row.payment))
                  throw new LocalDataError(400, '请填写订单产品和付款方式');
                const error = checkNewOrder(row);
                if (error) throw new LocalDataError(400, error);
                row.orderNo = nextOrderNo(seen);
                row.costSettings = orderCostSnapshot(current('settings')?.costSettings);
                delete row.issueFeeSnapshot;
                delete row.cardUsedAt;
                seen.push(row);
                for (const movement of incoming.get('appleBalance')?.movements || [])
                  if (movement.orderId === row.id) movement.orderNo = row.orderNo;
              }
              const recordsNewUse = row.payment === '银行卡' && !hasBankPayment(prior) &&
                (!prior || row.paidConfirmed || needsOrderCardCheck(row, prior) || row.proCardNumber !== prior.proCardNumber);
              const renewal = (!prior || recordsNewUse) ? bankRenewalSource(row, oldOrders) : undefined;
              if (!prior && row.businessType === '续费' && !personalProduct(row.product)) {
                if (renewal) row.previousOrderId = renewal.id;
                else delete row.previousOrderId;
              } else if (prior && !personalProduct(row.product)) retainOrderField(row, prior, 'previousOrderId');
              if (recordsNewUse && row.cardBackfillConfirmed !== true) {
                const selected = cards.get(row.cardId) || tenantCards.find(card => card.id === row.cardId);
                const number = selected?.number || row.proCardNumber;
                const fingerprint = this.orderCardFingerprint(number);
                if (frozenOrderCard(freezes, row.cardId, fingerprint))
                  throw new LocalDataError(409, '所选银行卡已冻结，请更换可用银行卡');
                if (row.paidConfirmed && !fingerprint && !row.cardId && frozenRenewalCard(this, freezes, renewal))
                  throw new LocalDataError(409, '原银行卡已冻结，请登记可用的新银行卡后再提交');
              }
              if (!automatic && row.payment === '银行卡' && row.paidConfirmed === true &&
                  (!prior?.paidConfirmed || row.paidAmount !== prior.paidAmount || row.paidCurrency !== prior.paidCurrency) &&
                  (!positiveOrderAmount(row.paidAmount) || !validCurrencyCode(row.paidCurrency)))
                throw new LocalDataError(400, '请登记实际银行卡代付金额与币种');
              let cardBackfilled = false;
              if (Object.hasOwn(row, 'cardBackfillConfirmed')) {
                // Do not infer or rewrite the historical card type or first-use fee.
                retainOrderField(row, prior, 'cardTypeId');
                retainOrderField(row, prior, 'cardTypeName');
                const card = cards.get(row.cardId);
                const issue = historicalGptCardBackfillError(prior, row, {
                  action, card, changedOrderCount, previousLogs: priorCommerce?.logs || [], nextLogs: commerce.logs, actor
                });
                if (issue) throw new LocalDataError(409, issue);
                delete row.cardBackfillConfirmed;
                row.paymentId = card.last4;
                retainOrderCardNumber(row, prior, card);
                if (!row.proCardNumber)
                  throw new LocalDataError(503, '银行卡完整资料未能核对，请刷新后重试');
                cardBackfilled = true;
                verifiedCardBackfillId = row.id;
              }
              if (cardBackfilled) {
                // This only associates existing evidence; it neither creates a payment
                // nor records a new card use or an unverified opening fee.
              } else if (action === '补偿撤回更正' && row.payment === '银行卡' &&
                  prior?.corrections?.at(-1)?.versionAfter === prior.version) {
                const original = prior.corrections.at(-1).previous;
                row.paymentId = original.paymentId;
                retainOrderCardNumber(row, original);
              } else if (isOrderBankMaterials(row) && !row.cardId) {
                // Manual materials were normalized above and live in the encrypted order document.
              } else if (needsOrderCardCheck(row, prior)) {
                if (usesRechargeCard(row)) {
                  const card = cards.get(row.cardId);
                  if (!card?.active) throw new LocalDataError(409, '请选择当前可用的代充卡池银行卡');
                  if (!/^\d{12,19}$/.test(card.number || '') || !card.number.endsWith(card.last4))
                    throw new LocalDataError(503, '银行卡完整资料未能核对，请刷新重试或手动填写');
                  row.paymentId = card.last4;
                  retainOrderCardNumber(row, prior, card);
                  if (!hasBankPayment(prior) && (row.product === 'GPT' || personalProduct(row.product))) {
                    const fee = deriveCardIssueFee(row, prior, [...oldOrders, ...settledThisWrite], card);
                    if (fee) row.issueFeeSnapshot = fee;
                    else delete row.issueFeeSnapshot;
                    if (row.paidConfirmed) row.cardUsedAt = new Date().toISOString();
                  }
                } else if (row.product?.startsWith('Claude') && typeof row.cardId === 'string' && row.cardId.startsWith('tenant:')) {
                  const card = tenantCards.find((item) => item.id === row.cardId && item.tenantId === row.tenantId && item.active);
                  if (!card || (row.proMaterialMode === 'tenant_card' &&
                      !commerce.tenants.some((item) => item.id === row.tenantId && item.active !== false)))
                    throw new LocalDataError(409, '请选择当前用卡人名下的银行卡');
                  row.paymentId = card.number.slice(-4);
                  retainOrderCardNumber(row, prior, card);
                } else if (row.product === 'GPT' && !row.cardId) {
                  row.cardId = '';
                  row.paymentId = prior?.payment === '银行卡' && !prior.cardId ? prior.paymentId || '' : '';
                  if (row.paidConfirmed) row.issueFeeSnapshot = { cardId: '', applied: false, pending: true };
                } else if (row.cardId || row.paidConfirmed) {
                  throw new LocalDataError(409, '请选择对应来源的银行卡');
                } else row.paymentId = '';
              } else if (row.payment === '银行卡') {
                retainOrderField(row, prior, 'paymentId');
                retainOrderCardNumber(row, prior);
              }
              if (action !== snapshotAction && action !== historicalFeeAction && !cardBackfilled)
                normalizePaymentEvidence(row, prior, automatic);
              if (row.payment === '银行卡' && row.paidConfirmed) settledThisWrite.push(row);
            }
          }
          const error =
            checkBankReturns(priorCommerce, commerce) ||
            checkOrderFinancialHistory(priorCommerce, commerce) ||
            checkFinanceSnapshots(priorCommerce, commerce, { action, verifyAutomaticSnapshot, actor, verifiedCardBackfillId,
              currentCostSettings: action === historicalFeeAction ? orderCostSnapshot(current('settings')?.costSettings) : undefined });
          if (error) throw new LocalDataError(409, error);
          isolatedHistoricalOrderCorrection = action === historicalFeeAction || Boolean(verifiedCardBackfillId);
        }
        if (checksStock) {
          // Previously delivered accounts can be new to this system. Validate their transition in memory.
          const deliveryInventory = relayIntake?.deliveryAccounts.length ? {
            ...priorInventory, accounts: [...(priorInventory?.accounts || []), ...relayIntake.deliveryAccounts]
          } : priorInventory;
          const error = checkStockDeliveries(priorCommerce, commerce, deliveryInventory, inventory, actor ?? localToolboxActor);
          if (error) throw new LocalDataError(409, error);
        }
        if (checksStock || incoming.has('appleBalance')) {
          const previous = current('appleBalance');
          const balanceWrite = writes.find(write => write.domain === 'appleBalance');
          let ledger = balanceWrite?.data ?? previous ?? emptyAppleLedger();
          if (balanceWrite) {
            const priorIds = new Set((previous?.movements || []).map(item => item.id));
            const additions = ledger.movements.filter(item => !priorIds.has(item.id));
            if (additions.some(item => item.kind === 'opening') ||
                (balanceWrite.action === 'apple_topup' &&
                  (additions.length !== 1 || additions[0].kind !== 'topup')) ||
                additions.some(item => item.kind === 'topup' && balanceWrite.action !== 'apple_topup'))
              throw new LocalDataError(409, '请通过对应入口登记苹果 ID 期初余额或充值');
            for (const item of additions.filter(row => row.kind === 'topup')) {
              item.actor = (actor || localToolboxActor).name;
              item.actorId = (actor || localToolboxActor).id;
              item.at = toV2DateTimeInput(new Date()).replace('T', ' ');
              item.label = '充值到账';
            }
          }
          if (inventoryWrite) {
            const opened = stageAppleOpenings(priorInventory, inventory, ledger, actor || localToolboxActor, new Date(), priorCommerce?.orders);
            if (opened.error) throw new LocalDataError(400, opened.error);
            if (opened.changed) {
              if (balanceWrite) throw new LocalDataError(409, '期初余额由新增苹果 ID 操作一并登记');
              ledger = opened.ledger;
              writes.push({ domain: 'appleBalance', version: readDocument('appleBalance').version,
                data: ledger, action: 'apple_opening' });
            }
          }
          if (incoming.has('commerce')) {
            const error = stageAppleOrderFunding(priorCommerce?.orders, commerce.orders, previous,
              inventory, current('settings'), writes.find(write => write.domain === 'commerce').action, commerce.customers);
            if (error) throw new LocalDataError(409, error);
          }
          const error = checkAppleLedger(
            previous,
            ledger,
            checksStock ? inventory : current('inventory'),
            checksStock ? commerce : current('commerce')
          );
          if (error) throw new LocalDataError(409, error);
        }
        const now = new Date().toISOString();
        if (inventory && (inventoryWrite || incoming.has('commerce')) && !isolatedHistoricalOrderCorrection) {
          const next = inventoryWrite ? inventory : structuredClone(inventory);
          const matches = inspectInventoryUsage(next, commerce, Date.parse(now));
          const oldRegistrationIds = new Set((priorInventory?.registrationRecords || []).map(row => row.id));
          if ((next.registrationRecords || []).some(row => row.accountId && ['Gemini', 'Grok'].includes(row.product) &&
              !oldRegistrationIds.has(row.id) && (matches.get(row.assetId)?.status !== 'used' ||
                matches.get(row.assetId)?.evidence.registrationId !== row.id)))
            throw new LocalDataError(409, '邮箱使用结果待核对，账号和领用资料尚未保存');
          if (relayIntake) {
            for (const id of matches.keys()) if (!relayIntake.aliasIds.has(id)) matches.delete(id);
          } else if (inventoryWrite?.action !== 'inventory_reconcile_usage') {
            for (const [id, match] of matches) {
              const prior = priorUsage.get(id);
              if (prior?.status === 'used' && !returnedBatches.has(match.claim?.batch.id) &&
                prior.evidence.accountId === match.evidence.accountId &&
                prior.evidence.orderId === match.evidence.orderId &&
                prior.evidence.registrationId === match.evidence.registrationId) matches.delete(id);
            }
          }
          const usageChanged = applyInventoryUsage(matches, actor, new Date(now));
          if (usageChanged && inventoryWrite) {
            const priorAccountIds = new Set((priorInventory?.accounts || []).map(row => row.id));
            const newAccounts = new Map(next.accounts.filter(row => !priorAccountIds.has(row.id)).map(row => [row.id, row]));
            for (const { asset, evidence, status } of matches.values()) {
              const account = status === 'used' && evidence.kind === 'registration' && newAccounts.get(evidence.accountId);
              if (account) account.emailType = asset.type;
            }
          }
          if (relayIntake && next.mailboxes.some(row => relayIntake.aliasIds.has(row.id) &&
              (row.inventoryState || (row.used ? 'used' : 'available')) !== 'used'))
            throw new LocalDataError(409, '存在无法确认注册使用的隐藏邮箱，请核对原资料后重新预检');
          const lifecycleChanged = incoming.has('commerce') && applyAccountOrderLifecycle(priorCommerce, commerce, next, actor, new Date(now));
          if (usageChanged || lifecycleChanged) {
            const error = checkInventoryHistory(priorInventory, next, { trustedAccountLifecycle: true });
            if (error) throw new LocalDataError(409, error);
            if (!inventoryWrite) writes.push({
              domain: 'inventory', version: readDocument('inventory').version,
              data: next, action: 'inventory_reconcile_usage'
            });
            inventory = next;
          }
        }
        const tenantCardDocument = incoming.has('commerce') ? readDocument('tenant-cards') : null;
        let initialTenantCards;
        try {
          initialTenantCards = incoming.has('commerce')
            ? stageInitialTenantCards(priorCommerce, commerce, tenantCardDocument.data?.items || [])
            : { additions: [], targets: [] };
        } catch (error) { throw new LocalDataError(400, error.message); }
        const result = [];
        for (const { domain, version, data, action } of writes) {
          const next = version + 1;
          const label =
            actionLabels[domain]?.[action] ||
            (action === 'local_save' ? `保存${domainLabels[domain]}资料` : action);
          put.run(domain, next, encrypt(key, domain, next, JSON.stringify(data)));
          if (domain === 'inventory' && primaryTargets) {
            for (const target of primaryTargets)
              log.run(now, domain, target.action, auditSummary(inventoryActions[target.action], actor, target.id), next);
          } else log.run(now, domain, action, auditSummary(label, actor), next);
          const review = domain === 'inventory'
            ? usageReviewRows(inspectInventoryUsage(inventory, commerce, Date.parse(now)))
            : [];
          result.push({ domain, version: next, data, ...(review.length && { usageReview: review }),
            ...(domain === 'inventory' && { accountSummaries: accountLifecycleSummaries(data, commerce),
              commerceVersion: writes.find(write => write.domain === 'commerce')?.version + 1 || readDocument('commerce').version }) });
        }
        if (initialTenantCards.additions.length) {
          const version = tenantCardDocument.version + 1;
          const data = { ...tenantCardDocument.data, items: [...(tenantCardDocument.data?.items || []), ...initialTenantCards.additions] };
          put.run('tenant-cards', version, encrypt(key, 'tenant-cards', version, JSON.stringify(data)));
          for (const id of initialTenantCards.targets)
            log.run(now, 'tenant-cards', 'tenant_initial_cards', auditSummary('随租户新增登记银行卡', actor, id), version);
        }
        return result;
      });
    },
    orderCardFingerprint(number) {
      return typeof number === 'string' && /^\d{12,19}$/.test(number)
        ? createHmac('sha256', key).update('order-card-number\0').update(number).digest('hex') : '';
    },
    featureDocument(domain) {
      if (!orderFeatureDomains.has(domain)) throw new TypeError('未知订单附属资料');
      return readDocument(domain);
    },
    saveFeatureDocument(domain, version, data, { action, actor, targetId, commerceVersion } = {}) {
      if (!orderFeatureDomains.has(domain)) throw new TypeError('未知订单附属资料');
      return writeTransaction(() => {
        if (readDocument(domain).version !== version) throw new LocalDataError(409, '资料已更新，请刷新后重试');
        if (domain === 'finance-rates' && commerceVersion !== undefined && readDocument('commerce').version !== commerceVersion)
          throw new LocalDataError(409, '订单报价引用已更新，请重新预览清理范围');
        if (domain === cardFreezeDocument && commerceVersion !== undefined && readDocument('commerce').version !== commerceVersion)
          throw new LocalDataError(409, '订单已变化，请刷新后核对用卡');
        const next = version + 1;
        put.run(domain, next, encrypt(key, domain, next, JSON.stringify(data)));
        if (action) log.run(new Date().toISOString(), domain, action,
          auditSummary(orderFeatureAuditLabels[action] || action, actor, targetId), next);
        return { version: next, data };
      });
    },
    auditFeature(domain, version, { action, actor, targetId }) {
      if (!orderFeatureDomains.has(domain)) throw new TypeError('未知订单附属资料');
      log.run(new Date().toISOString(), domain, action, auditSummary(action, actor, targetId), version);
    },
    rememberRechargeSessions(jobKeys, scanOffset) {
      return writeTransaction(() => {
        const current = readDocument('order-sync');
        const known = new Set(current.data.rows.map(({ jobKey }) => jobKey));
        const rows = [...current.data.rows, ...jobKeys.filter((id) => !known.has(id)).map((jobKey) => ({
          jobKey, needs: ['等待获取成功回执']
        }))];
        if (rows.length === current.data.rows.length && scanOffset === current.data.scanOffset) return current.data;
        const data = { ...current.data, rows, scanOffset };
        const version = current.version + 1;
        put.run('order-sync', version, encrypt(key, 'order-sync', version, JSON.stringify(data)));
        return data;
      });
    },
    orderCompletionView(actor, params, readOrderOwners) {
      return readOrderCompletion(readDocument('commerce').data, readDocument('settings').data, actor, params, readOrderOwners);
    },
    saveOrderCompletion(actor, command, readOrderOwners) {
      return writeTransaction(() => {
        const current = readDocument('commerce');
        const data = current.data;
        const at = new Date().toISOString();
        const version = current.version + 1;
        if (command?.action === 'assign-manual-owners') {
          const assigned = assignMissingManualOrderOwners(data, actor, command, readOrderOwners, at);
          if (!assigned.length) return { assigned: 0, version: current.version };
          const byId = new Map(assigned.map(order => [order.id, order]));
          const label = '补齐手工订单归属';
          data.orders = data.orders.map(row => byId.get(row.id) || row);
          data.logs = [...assigned.map(order => ({
            id: 'commerce-log-' + randomUUID(), type: label, entityId: order.id, detail: order.orderNo,
            at: auditDate.format(new Date(at)).slice(0, 16), actor: actor.name, actorId: actor.id
          })), ...(data.logs || [])];
          put.run('commerce', version, encrypt(key, 'commerce', version, JSON.stringify(data)));
          for (const order of assigned)
            log.run(at, 'commerce', 'order_completion_assign_manual_owner', auditSummary(label, actor, order.id), version);
          return { assigned: assigned.length, version };
        }
        const manual = command?.action === 'fill-manual-details';
        const prior = manual && data?.orders?.find(row => row.id === command.orderId);
        const legacyConfirmed = prior && legacyOpeningOrderIds([prior], readDocument(subscriptionDomain).data).length > 0;
        const { order, customer, createdCustomer } = manual
          ? fillManualOrderDetails(data, readDocument('inventory').data, actor, command, at, legacyConfirmed)
          : applyOrderCompletion(data, readDocument('settings').data, actor, command, readOrderOwners, at);
        data.orders = data.orders.map((row) => row.id === order.id ? order : row);
        if (customer) {
          const customers = data.customers || [];
          data.customers = createdCustomer ? [customer, ...customers]
            : customers.map((row) => row.id === customer.id ? customer : row);
        }
        const label = manual ? manualOrderDetailsAction : command.action === 'assign' ? '确认代充订单归属' : '补全代充订单资料';
        data.logs = [{
          id: 'commerce-log-' + randomUUID(), type: label, entityId: order.id, detail: order.orderNo,
          at: auditDate.format(new Date(at)).slice(0, 16), actor: actor.name, actorId: actor.id
        }, ...(data.logs || [])];
        put.run('commerce', version, encrypt(key, 'commerce', version, JSON.stringify(data)));
        log.run(at, 'commerce', 'order_completion_' + command.action, auditSummary(label, actor, order.id), version);
        if (customer) log.run(at, 'commerce', createdCustomer ? 'order_completion_customer_create' : 'order_completion_customer_fill',
          auditSummary(createdCustomer ? '补全订单时新增客户' : '补齐客户资料', actor, customer.id), version);
        return { orderId: order.id, version };
      });
    },
    applyRechargeOrder({ since, row, order, firstUse }) {
      return writeTransaction(() => {
        const status = readDocument('order-sync');
        const commerce = readDocument('commerce');
        const data = commerce.data || { customers: [], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] };
        const previous = status.data?.rows || [];
        const old = data.orders.find((item) => item.taskId === row.jobKey && item.source === '线上代充');
        const result = { ...row };
        let changed;
        if (old) {
          result.orderNo = old.orderNo;
          if (order && (!order.email || !old.email || order.email.toLowerCase() === old.email.toLowerCase()) &&
              (!order.plan || !old.plan || order.plan === old.plan)) {
            const next = { ...old, entitlementStatus: 'active' };
            if (!old.email && order.email) next.email = order.email;
            if (!old.plan && order.plan) {
              next.plan = order.plan;
              const price = rechargePriceSnapshot(readDocument('settings'), order.plan, new Date().toISOString());
              next.rechargePriceSnapshot = price;
              if (!old.saleAmount && !old.receiptConfirmed) next.saleAmount = price.saleAmount;
            }
            if (!old.ownerId && !old.rechargeOwnerId && !old.createdById && order.rechargeOwnerId)
              next.rechargeOwnerId = order.rechargeOwnerId;
            if (!old.paidConfirmed && !old.paidAmount && !old.paidCurrency && order.paidConfirmed) {
              for (const field of ['paidAmount', 'paidCurrency', 'paidConfirmed']) next[field] = order[field];
              next.financialEvidence = [...(old.financialEvidence || []), ...order.financialEvidence];
            }
            if (!old.start && !old.expiry && order.start) {
              for (const field of ['start', 'expiry', 'rechargeCompletedAt']) next[field] = order[field];
            }
            if (!old.paymentId && order.paymentId) next.paymentId = order.paymentId;
            if (!old.cardId && order.cardId && next.paymentId === order.paymentId && old.proMaterialMode !== 'manual_card') next.cardId = order.cardId;
            if (!old.proCardNumber && order.proCardNumber && next.cardId === order.cardId && next.paymentId === order.paymentId)
              next.proCardNumber = order.proCardNumber;
            if (!old.fxSnapshot && order.fxSnapshot && next.start === order.start &&
                next.paidCurrency === order.paidCurrency && next.saleCurrency === order.saleCurrency)
              next.fxSnapshot = order.fxSnapshot;
            const recordedFirst = next.cardId && data.orders.some((item) =>
              item.id !== next.id && item.cardId === next.cardId && item.issueFeeSnapshot?.applied);
            if (JSON.stringify(next) !== JSON.stringify(old) ||
                (next.paidConfirmed && next.issueFeeSnapshot?.pending && (typeof firstUse === 'boolean' || recordedFirst))) {
              next.version++;
              data.orders[data.orders.indexOf(old)] = next;
              changed = next;
            }
          } else if (order) result.needs = ['成功回执与已有订单不一致'];
        } else if (order) {
          const id = 'commerce-order-' + randomUUID();
          const orderNo = nextOrderNo(data.orders);
          const price = rechargePriceSnapshot(readDocument('settings'), order.plan, new Date().toISOString());
          changed = { ...order, id, orderNo, entitlementStatus: 'active', saleAmount: price.saleAmount, rechargePriceSnapshot: price };
          data.orders.unshift(changed);
          result.orderNo = orderNo;
        }
        if (changed) {
          if (changed.cardId && !old?.cardId && !changed.cardTypeId) {
            const { id, name } = cardTypeSnapshot(readDocument(cardTypeDocument).data, { cardId: changed.cardId });
            if (id) {
              changed.cardTypeId = id;
              changed.cardTypeName = name;
            }
          }
          if (changed.cardId && changed.issueFeeSnapshot?.pending) {
            const earlierFee = data.orders.some((item) => item.id !== changed.id &&
              item.cardId === changed.cardId && item.issueFeeSnapshot?.applied);
            if (earlierFee || (typeof firstUse === 'boolean' && changed.paidConfirmed)) {
              changed.issueFeeSnapshot = {
                cardId: changed.cardId, applied: !earlierFee && firstUse === true, amountUsd: changed.costSettings.cardIssueUsd,
                at: new Date().toISOString()
              };
            }
          }
          const next = commerce.version + 1;
          put.run('commerce', next, encrypt(key, 'commerce', next, JSON.stringify(data)));
          const actor = { id: 'order-reconciliation', name: '自动充值' };
          log.run(new Date().toISOString(), 'commerce', 'recharge_order_import',
            auditSummary(old ? '补齐代充订单回执' : '同步代充成功订单', actor, changed.id), next);
        }
        const currentOrder = changed || old;
        if (currentOrder) {
          const filled = {
            '邮箱证据待核对': currentOrder.email,
            '套餐证据待核对': currentOrder.plan,
            '开通时间待核对': currentOrder.rechargeCompletedAt,
            '实扣金额待核对': currentOrder.paidConfirmed,
            '卡尾待核对': currentOrder.paymentId,
            '银行卡归属待核对': currentOrder.cardId,
            '首次开卡费待核对': currentOrder.issueFeeSnapshot && !currentOrder.issueFeeSnapshot.pending,
            '订单汇率尚未取得': currentOrder.fxSnapshot
          };
          result.needs = result.needs.filter(issue => !filled[issue]);
        }
        const version = status.version + 1;
        const records = { ...status.data, since: status.data?.since ?? since,
          rows: [...previous.filter((item) => item.jobKey !== row.jobKey), result] };
        put.run('order-sync', version, encrypt(key, 'order-sync', version, JSON.stringify(records)));
        return result;
      });
    },
    subscribeChanges(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    notifyChanges,
    changeVersions(actor) {
      const version = domain => String(revision.get(domain)?.version ?? 0);
      const versions = { inventory: version('inventory'), commerce: version('commerce'), 'recharge-codes': version('recharge-codes') };
      for (const scope of ['toolbox', savedTotpDomain, bitBrowserConnectionDomain, bitBrowserProxyDomain, bitBrowserAddressDomain])
        versions[scope] = version(`${scope}:${actor.id}`);
      if (['admin', 'super'].includes(actor.role)) {
        for (const scope of ['settings', 'appleBalance', 'tenant-cards', 'recharge-codes', 'order-sync', 'finance-rates',
          cardTypeDocument, cardFreezeDocument, subscriptionDomain]) versions[scope] = version(scope);
        versions['tools/mailbox-pool'] = version(managedMailboxDomain);
        versions['tools/website-visits'] = version(websiteVisitsDomain);
        versions['apple-relay'] = String(relayRevision.get().version);
        versions.audit = String(auditRevision.get().version);
      }
      return versions;
    },
    audit: () => audit.all().map(readAuditRow),
    auditPage: (search) => pageAuditRows(audit.all().map(readAuditRow), search),
    recordAuthEvent({ action, actor, targetId }) {
      if (sessionEventLabels[action])
        log.run(
          new Date().toISOString(),
          action.startsWith('relay_') ? 'inventory' : 'auth',
          action,
          auditSummary(sessionEventLabels[action], actor, targetId),
          0
        );
    },
    close: () => { changeListeners.clear(); db.close(); }
  };
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new LocalDataError(415, '请提交 JSON 资料');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maximumBodyBytes) {
      request.resume();
      throw new LocalDataError(413, '本机保存资料超过大小限制');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LocalDataError(400, '无法读取 JSON 资料');
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function codeReadPage(body) {
  const { ids, version } = body;
  if (Object.keys(body).length !== 2 || !Number.isSafeInteger(version) || version < 0 ||
      !Array.isArray(ids) || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 128))
    throw new LocalDataError(400, '请核对本页账号编号及列表版本');
  return { ids, version };
}

export async function handleLocalBusiness(
  request,
  response,
  route,
  store,
  actor,
  { verifyRelayExtraction, verifyManagedMailbox, publicOrigin, readOrderCards, readOrderOwners } = {}
) {
  try {
    const domain = route.slice('/api/local/'.length);
    if (domain === 'commerce' || domain === 'batch') response.setHeader('Cache-Control', 'private, no-store');
    const origin = publicOrigin || `http://${request.headers.host}`;
    if (
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      throw new LocalDataError(403, '仅允许从本机页面访问');
    }
    if (domain === 'order-completion') {
      response.setHeader('Cache-Control', 'private, no-store');
      requireCompletionActor(actor);
      if (request.method === 'GET')
        return json(response, 200, store.orderCompletionView(actor, new URL(request.url, origin).searchParams, readOrderOwners));
      if (request.method !== 'POST') throw new LocalDataError(405, '不支持此补全操作');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面保存补全资料');
      return json(response, 200, store.saveOrderCompletion(actor, await readJson(request), readOrderOwners));
    }
    if (domain === 'claude-history-intake') {
      response.setHeader('Cache-Control', 'private, no-store');
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以进行 Claude 历史入库');
      if (request.method !== 'POST') throw new LocalDataError(405, '不支持此历史入库操作');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面操作');
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new LocalDataError(400, '请核对历史入库资料');
      const { mode, ...input } = body;
      if (mode === 'preview') return json(response, 200, store.previewClaudeHistory(input));
      if (mode === 'confirm') return json(response, 200, store.saveClaudeHistory(input, actor));
      throw new LocalDataError(400, '请选择预检或确认入库');
    }
    if (domain === 'tenant-owner-transfer') {
      if (!actor?.id || !['admin', 'super'].includes(actor.role))
        throw new LocalDataError(403, '只有管理员可以转交租户归属');
      response.setHeader('Cache-Control', 'private, no-store');
      if (request.method === 'GET')
        return json(response, 200, store.tenantOwnerTransferView(new URL(request.url, origin).searchParams.get('tenantId')));
      if (request.method !== 'POST') throw new LocalDataError(405, '不支持此归属操作');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面转交归属');
      return json(response, 200, store.transferTenantOwner(await readJson(request), actor, readOrderOwners));
    }
    if (domain === 'tools/mailbox-pool') {
      if (!['admin', 'super'].includes(actor?.role)) throw new LocalDataError(403, '只有管理员可以管理邮箱池');
      response.setHeader('Cache-Control', 'private, no-store');
      if (request.method === 'GET') return json(response, 200, store.loadManagedMailboxPool());
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从本机页面使用');
      if (request.method === 'POST') {
        const body = await readJson(request);
        if (body?.ids !== undefined)
          return json(response, 200, store.readManagedMailboxCodePage(codeReadPage(body), actor));
        return json(response, 200, store.copyManagedMailboxCode(body?.id, actor));
      }
      if (request.method === 'PUT')
        return json(response, 200, await store.saveVerifiedManagedMailboxPool(await readJson(request), actor, verifyManagedMailbox));
      throw new LocalDataError(405, '本机接口不支持此操作');
    }
    if ([savedTotpDomain, savedTotpDomain + '/code', savedTotpDomain + '/secret'].includes(domain)) {
      if (!actor) throw new LocalDataError(401, '请先登录');
      response.setHeader('Cache-Control', 'private, no-store');
      if (domain === savedTotpDomain && request.method === 'GET')
        return json(response, 200, store.loadSavedTotp(actor));
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从本机页面使用');
      if (domain === savedTotpDomain && request.method === 'PUT')
        return json(response, 200, await store.saveSavedTotp(await readJson(request), actor));
      if (domain === savedTotpDomain + '/code' && request.method === 'POST') {
        const body = await readJson(request);
        if (body?.ids !== undefined)
          return json(response, 200, await store.readSavedTotpCodePage(codeReadPage(body), actor));
        return json(response, 200, await store.useSavedTotp(body?.id, actor));
      }
      if (domain === savedTotpDomain + '/secret' && request.method === 'POST')
        return json(response, 200, store.revealSavedTotp(await readJson(request), actor));
      throw new LocalDataError(405, '本机接口不支持此操作');
    }
    if (domain === bitBrowserWindowDomain) {
      if (!actor?.id) throw new LocalDataError(401, '请先登录');
      response.setHeader('Cache-Control', 'private, no-store');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面操作');
      if (request.method === 'POST') return json(response, 200, store.loadBitBrowserWindow(await readJson(request), actor));
      if (request.method === 'PUT') return json(response, 200, store.saveBitBrowserWindow(await readJson(request), actor));
      throw new LocalDataError(405, '原窗口接口不支持该操作');
    }
    if (request.method === 'PATCH' && Object.hasOwn(bitBrowserDefaultKeys, domain)) {
      if (!actor?.id) throw new LocalDataError(401, '请先登录');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面操作');
      response.setHeader('Cache-Control', 'private, no-store');
      return json(response, 200, store.saveBitBrowserDefault(domain, await readJson(request), actor));
    }
    if (domain === bitBrowserProxyDomain) {
      if (!actor?.id) throw new LocalDataError(401, '请先登录');
      response.setHeader('Cache-Control', 'private, no-store');
      if (request.method === 'GET') return json(response, 200, store.loadBitBrowserProxies(actor));
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从当前页面操作');
      if (request.method === 'PUT') return json(response, 200, store.saveBitBrowserProxy(await readJson(request), actor));
      if (request.method === 'POST') return json(response, 200, store.useBitBrowserProxy(await readJson(request), actor));
      throw new LocalDataError(405, '此 IP 接口不支持该操作');
    }
    if (domain === bitBrowserConnectionDomain && request.method === 'POST') {
      if (!actor?.id) throw new LocalDataError(401, '请先登录');
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从本机页面使用');
      response.setHeader('Cache-Control', 'private, no-store');
      return json(response, 200, store.useBitBrowserConnectionSecrets(await readJson(request), actor));
    }
    if (request.method === 'GET') {
      if (domain === 'toolbox') return json(response, 200, store.loadToolbox(actor));
      if (domain === bitBrowserConnectionDomain) {
        response.setHeader('Cache-Control', 'private, no-store');
        if (actor?.id) response.setHeader('X-ID-BitBrowser-Token-Storage', 'enabled');
        return json(response, 200, store.loadBitBrowserConnections(actor));
      }
      if (domain === bitBrowserAddressDomain) {
        const { searchParams } = new URL(request.url, origin);
        return json(response, 200, store.listBitBrowserAddresses(searchParams, actor));
      }
      if (domain === 'audit/page') {
        const { searchParams } = new URL(request.url, origin);
        return json(response, 200, store.auditPage(searchParams));
      }
      if (domain === 'inventory') {
        response.setHeader('Cache-Control', 'private, no-store');
        return json(response, 200, store.inventorySnapshot(actor));
      }
      if (domain === 'commerce') return json(response, 200, commerceForActor(store, store.load(domain), actor));
      return json(response, 200, domain === 'audit' ? store.audit() : store.load(domain));
    }
    if (request.method !== 'PUT') throw new LocalDataError(405, '本机接口不支持此操作');
    if (request.headers.origin !== origin) {
      throw new LocalDataError(403, '仅允许从本机页面保存');
    }
    const body = await readJson(request);
    if (domain === 'batch') {
      const entries = await saveHttpWrites(store, body, actor, verifyRelayExtraction, readOrderCards, readOrderOwners);
      return json(response, 200, entries.map((entry) =>
        entry.domain === 'commerce' ? commerceForActor(store, entry, actor) : entry));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalDataError(400, '保存资料格式不正确');
    }
    if (domain === 'inventory/usage-correction') return json(response, 200, store.saveInventoryUsageCorrection(body, actor));
    if (domain === 'inventory/account-lifecycle') return json(response, 200, store.saveAccountLifecycle(body, actor));
    if (domain === 'toolbox') return json(response, 200, store.saveToolbox(body, actor));
    if (domain === bitBrowserConnectionDomain) {
      if ((Object.hasOwn(body, 'interfaceToken') || Object.hasOwn(body, 'staticProxyCredentials')) && !actor?.id)
        throw new LocalDataError(401, '请先登录再保存连接凭据');
      if (actor?.id) response.setHeader('X-ID-BitBrowser-Token-Storage', 'enabled');
      return json(response, 200, store.saveBitBrowserConnection(body, actor));
    }
    if (domain === bitBrowserAddressDomain) {
      return json(response, 200, store.saveBitBrowserAddresses(body, actor));
    }
    const [entry, ...related] = await saveHttpWrites(store, [{ ...body, domain }], actor, verifyRelayExtraction, readOrderCards, readOrderOwners);
    const inventory = related.find(item => item.domain === 'inventory');
    const appleBalance = related.find(item => item.domain === 'appleBalance');
    const result = {
      version: entry.version, data: entry.data,
      ...(entry.accountSummaries && { accountSummaries: entry.accountSummaries, commerceVersion: entry.commerceVersion }),
      ...(entry.usageReview && { usageReview: entry.usageReview }),
      ...(inventory && { inventory }),
      ...(appleBalance && { appleBalance })
    };
    return json(response, 200, entry.domain === 'commerce' ? commerceForActor(store, result, actor) : result);
  } catch (error) {
    if (response.destroyed) return;
    if (
      error instanceof LocalDataError ||
      error instanceof TenantOwnerTransferError ||
      error instanceof OrderCompletionError ||
      error instanceof ClaudeHistoryIntakeError ||
      error instanceof AccountLifecycleError ||
      error instanceof RelayClaimError ||
      error instanceof BitBrowserAddressError ||
      error instanceof BitBrowserConnectionError ||
      error instanceof BitBrowserWindowError ||
      error instanceof SavedTotpError ||
      error instanceof MailboxPoolError
    )
      return json(response, error.status, { error: error.message });
    return json(response, 500, { error: '本机数据读写失败，请重试' });
  }
}
