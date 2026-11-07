import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { currencies, snapshotAction } from '../modules/finance/accounting.mjs';
import { checkFinanceSnapshots } from './finance/snapshot-integrity.mjs';
import { appendWebsiteVisit, getWebsiteVisitIp, reportWebsiteVisits, websiteVisitsDomain } from './tools/website-visits.mjs';
import {
  applyMailboxPoolWrite, findMailboxQuery, mailboxPoolItems, mailboxPoolMetadata, managedMailboxDomain, MailboxPoolError, prepareVerifiedMailboxWrite
} from './tools/mailbox-pool.mjs';
import {
  applyTotpWrite, generateSavedCode, savedTotpDomain, savedTotpMetadata, SavedTotpError, validateTotpWrite
} from './tools/saved-totp.mjs';
import {
  BitBrowserAddressError,
  bitBrowserAddressDomain,
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
import { checkInventoryHistory } from './inventory-history.mjs';
import { planLegacyMailboxImport } from './tools/legacy-mailbox-import.mjs';
import { planLegacyTotpImport } from './tools/legacy-totp-import.mjs';
import { applyInventoryUsage, correctInventoryUsage, inspectInventoryUsage, usageReviewRows } from './inventory-usage.mjs';
import { attributeInventory, defaultInventoryRegistrationTimes } from './inventory-attribution.mjs';
import { checkAccountLocations } from './inventory-account-location.mjs';
import { checkAppleOrder, checkNewOrder, deriveCardIssueFee, nextOrderNo, validMoney, validOrderPrices } from './order-policy.mjs';
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

const domainLabels = {
  inventory: '库存',
  commerce: '客户与订单',
  settings: '业务设置',
  appleBalance: '苹果 ID 余额'
};
const allowedDomains = new Set(Object.keys(domainLabels));
const verifiedAppleRelayPrimaries = Symbol('verifiedAppleRelayPrimaries');
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
  inventory_relay_alias_import: '批量登记苹果隐藏邮箱'
};
const settingsActions = {
  customer_tags_save: '保存客户标签设置',
  customer_sources_save: '保存客户来源设置',
  mailbox_category_save: '保存邮箱分类',
  mailbox_category_reorder: '调整邮箱分类排序',
  fee_rules_save: '保存费用规则',
  statistics_currency_save: '更改统计币种',
  order_prices_save: '保存订单套餐售价'
};
const appleBalanceActions = {
  apple_order_charge: '登记苹果内购扣款或冲正',
  apple_refund_schedule: '登记 Apple 待回款',
  apple_refund_correct: '更正 Apple 待回款',
  apple_refund_receive: '确认 Apple 回款到账',
  apple_adjust: '登记苹果 ID 余额变动',
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
    '拒续费',
    '恢复续费提醒',
    snapshotAction,
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
const orderFeatureDomains = new Set(['recharge-codes', 'tenant-cards', 'order-sync']);
const orderFeatureAuditLabels = {
  recharge_code_request: '申请充值码',
  recharge_code_approve: '批准充值码申请',
  recharge_code_reject: '驳回充值码申请',
  recharge_code_import_started: '提交充值码批次',
  recharge_code_issue_pending: '充值码发放待核对',
  recharge_code_issued: '确认发放充值码'
};
const verifiedOrderCards = Symbol('verifiedOrderCards');
const rechargeEvidenceFields = [
  'source', 'taskId', 'email', 'product', 'plan', 'businessType', 'payment', 'paymentId',
  'cardId', 'paidAmount', 'paidCurrency', 'start', 'expiry', 'paidConfirmed', 'rechargeCompletedAt',
  'accountSource', 'accountId'
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

function attributeCommerce(data, previous, actor) {
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
      if (!prior && (key === 'orders' || 'createdById' in row)) {
        row.createdById = actor.id;
        row.createdBy = actor.name;
      } else if (prior && (key === 'orders' || 'createdById' in prior)) {
        for (const field of ['createdById', 'createdBy']) {
          if (Object.hasOwn(prior, field)) row[field] = prior[field];
          else delete row[field];
        }
      }
      if ('updatedById' in row && row.version !== prior?.version) {
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
const needsOrderCardCheck = (row, prior) => row.payment === '银行卡' && !hasBankPayment(prior) &&
  (row.cardId !== prior?.cardId || row.tenantId !== prior?.tenantId || row.product !== prior?.product ||
    row.payment !== prior?.payment || (row.paidConfirmed && !prior?.paidConfirmed));

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

function normalizePaymentEvidence(row, prior, automatic) {
  if (!row.product) return;
  const evidence = Array.isArray(row.financialEvidence) ? row.financialEvidence : [];
  const historical = Array.isArray(prior?.financialEvidence) ? prior.financialEvidence : [];
  const normalized = historical.filter((item) => item?.kind === 'payment');
  const previous = prior?.paidConfirmed ? prior : null;
  for (const payment of automatic ? [] : [previous, row]) {
    if (!payment?.paidConfirmed || !positiveOrderAmount(payment.paidAmount) ||
        !currencies.includes(payment.paidCurrency)) continue;
    const cardId = payment.cardId || '';
    if (!normalized.some((item) => item.amount === payment.paidAmount && item.currency === payment.paidCurrency &&
        item.payment === payment.payment && item.cardId === cardId)) {
      normalized.push({ kind: 'payment', amount: payment.paidAmount, currency: payment.paidCurrency,
        payment: payment.payment, cardId, at: new Date().toISOString() });
    }
  }
  const receipts = evidence.filter((item) => item?.kind !== 'payment');
  if (!isDeepStrictEqual(evidence.filter((item) => item?.kind === 'payment'), normalized))
    row.financialEvidence = [...normalized, ...receipts];
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

async function saveHttpWrites(store, entries, actor, verifyRelayExtraction, readOrderCards) {
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
      return row.product === 'GPT' && typeof row.cardId === 'string' && row.cardId.startsWith('recharge:') &&
        needsOrderCardCheck(row, prior);
    });
    if (needPool) {
      try {
        for (const card of await readOrderCards()) orderCards.set(card.id, card);
      } catch {
        throw new LocalDataError(503, '暂时无法核对代充卡池，草稿已保留');
      }
    }
  }
  const options = { actor, [verifiedOrderCards]: orderCards };
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
  const log = db.prepare(`
    INSERT INTO business_audit (at, domain, action, summary, version) VALUES (?, ?, ?, ?, ?)
  `);
  const audit = db.prepare(
    'SELECT id, at, domain, action, summary, version FROM business_audit ORDER BY id DESC LIMIT 1000'
  );

  function readDocument(domain) {
    const row = get.get(domain);
    return row
      ? { version: row.version, data: decrypt(key, domain, row.version, row.payload) }
      : { version: 0, data: null };
  }

  function writeTransaction(save) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = save();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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
    return { ...metadata, items: metadata.items.map((row) => ({
      ...row, lastQueriedAt: activity.get(row.id) || previous.get(row.id) || null
    })) };
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
    load(domain) {
      checkDomain(domain);
      return readDocument(domain);
    },
    inventorySnapshot() {
      const snapshot = readDocument('inventory');
      const review = usageReviewRows(inspectInventoryUsage(snapshot.data, readDocument('commerce').data));
      return review.length ? { ...snapshot, usageReview: review } : snapshot;
    },
    saveAppleRelayPrimaries(rows, actor, aliases = [], registration) {
      const { version, data } = readDocument('inventory');
      const inventory = data ?? Object.fromEntries(inventoryLists.map((key) => [key, []]));
      const relay = inventory.appleRelay ??= { parents: [], imports: [], events: [] };
      const { parents } = relay;
      const time = new Date().toISOString();
      const batchId = registration?.batch ? `relay-import-${randomUUID()}` : '';
      const aliasAction = registration && !registration.batch
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
        const saved = before
          ? { ...before, remoteAliasId: row.remoteAliasId }
          : {
              ...row, aliasId: row.id, type: 'relay', source: '原收件服务',
              relayStatus: 'ACTIVE', health: 'normal', status: '正常',
              inventoryState: 'available', used: false, inventoryHistory: [], usageLinks: [],
              createdAt: typeof sourceCreatedAt === 'string' ? sourceCreatedAt : '', importedAt: time
            };
        if (registration && !before) Object.assign(saved, {
          source: 'Apple 主邮箱登记', importId: batchId,
          createdAt: time, createdById: actor.id, createdBy: actor.name,
          inventoryHistory: [{
            id: `relay-asset-event-${randomUUID()}`, action: '登记隐藏邮箱', detail: row.parentMailboxId,
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
      return this.saveBatch(
        [{ domain: 'inventory', version, data: inventory, action: registration ? aliasAction : 'inventory_relay_parent_save' }],
        { actor, [verifiedAppleRelayPrimaries]: [
          ...rows.map(({ id }) => ({ id, action: 'inventory_relay_parent_save' })),
          ...aliases.map(({ id }) => ({ id, action: aliasAction }))
        ] }
      )[0];
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
        return { version, data: snapshot.data, usageReview };
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
      return { version, profiles: summarizeBitBrowserConnections(data ?? []) };
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
        return { version, profiles: summarizeBitBrowserConnections(profiles), savedId };
      });
    },
    listBitBrowserAddresses(search, actor = localToolboxActor) {
      const { data } = readDocument(`${bitBrowserAddressDomain}:${actor.id}`);
      return listBitBrowserAddresses(data ?? [], search);
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
      const keys = importing ? ['streets'] : generating ? ['count'] : ['id', 'status', 'expectedStatus'];
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
        const { rows, result } = importing
          ? importBitBrowserAddresses(previous, body.streets, now)
          : generating
            ? generateBitBrowserAddresses(previous, body.count, now)
            : updateBitBrowserAddress(previous, body, now);
        let version = current.version;
        if (rows !== previous) {
          version++;
          put.run(domain, version, encrypt(key, domain, version, JSON.stringify(rows)));
        }
        const action = importing ? 'bitbrowser_address_import'
          : generating ? 'bitbrowser_address_generate' : 'bitbrowser_address_status';
        const label = importing
          ? `批量导入比特地址，新增 ${result.imported} 条，重复 ${result.duplicated} 条，无效 ${result.rejected} 条`
          : generating ? `生成比特账单地址 ${result.count} 条`
          : { used: '标记比特地址已使用', disabled: '停用比特地址', unused: '启用比特地址' }[
              result.status
            ];
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
      actor, verifyAutomaticSnapshot, [verifiedRelayClaimIds]: verifiedIds,
      [verifiedAppleRelayPrimaries]: primaryTargets, [verifiedOrderCards]: cards
    } = {}) {
      const writes = checkWrites(entries);
      return writeTransaction(() => {
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
          for (const key of ['customerTags', 'customerSources', 'orderPrices']) {
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
          const attributionError = attributeInventory(priorInventory, inventory, actor, write.action);
          if (attributionError) throw new LocalDataError(409, attributionError);
          defaultInventoryRegistrationTimes(priorInventory, inventory);
          const historyError = checkInventoryHistory(priorInventory, inventory);
          if (historyError) throw new LocalDataError(409, historyError);
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
          checkCustomerTagAssignments(
            priorCommerce, commerce, (incoming.get('settings') ?? current('settings'))?.customerTags
          );
          if (actor) attributeCommerce(commerce, priorCommerce, actor);
          const { action } = writes.find((write) => write.domain === 'commerce');
          if (cards) {
            const oldOrders = priorCommerce?.orders || [];
            const priorById = new Map(oldOrders.map((row) => [row.id, row]));
            const nextIds = new Set(commerce.orders.map(({ id }) => id));
            if (oldOrders.some((row) => row.source === '线上代充' && !nextIds.has(row.id)))
              throw new LocalDataError(409, '请使用既有业务撤单流程处理代充订单');
            const seen = [...oldOrders];
            const settledThisWrite = [];
            const tenantCards = current('tenant-cards')?.items || [];
            for (const row of commerce.orders) {
              const prior = priorById.get(row.id);
              if (prior && isDeepStrictEqual(row, prior)) continue;
              const automatic = prior?.source === '线上代充';
              if ((!automatic && row.source === '线上代充') || (row.taskId ?? '') !== (prior?.taskId ?? '') ||
                  (automatic && rechargeEvidenceFields.some((field) =>
                    (prior[field] ?? '') !== (row[field] ?? ''))))
                throw new LocalDataError(409, '线上代充来源只能由服务端登记');
              if (prior) {
                for (const field of ['orderNo', 'createdAt', 'costSettings', 'cardUsedAt', 'issueFeeSnapshot'])
                  retainOrderField(row, prior, field);
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
              if (row.product?.startsWith('Claude') && (!prior || row.tenantId !== prior.tenantId)) {
                const tenant = commerce.tenants.find((item) => item.id === row.tenantId && item.active !== false);
                if (row.tenantId && !tenant) throw new LocalDataError(409, '请选择可用的认证人');
                row.verifier = tenant?.name || '';
                row.verifierPhone = tenant?.phone || '';
                if (!prior) {
                  row.owner = '';
                  row.ownerPhone = '';
                }
              }
              if (row.product && (!prior || ['新增独立订单', '更正订单'].includes(action))) {
                const error = checkAppleOrder(row, prior, oldOrders, current('appleBalance'), inventory, commerce.orders);
                if (error) throw new LocalDataError(409, error);
              }
              if (!automatic && row.payment === '银行卡' && row.paidConfirmed === true &&
                  (!prior?.paidConfirmed || row.paidAmount !== prior.paidAmount || row.paidCurrency !== prior.paidCurrency) &&
                  (!positiveOrderAmount(row.paidAmount) || !currencies.includes(row.paidCurrency)))
                throw new LocalDataError(400, '请登记实际银行卡代付金额与币种');
              if (!automatic && hasBankPayment(prior)) {
                if (row.payment !== prior.payment || row.cardId !== prior.cardId ||
                    (typeof prior.cardId === 'string' && prior.cardId.startsWith('tenant:') && row.tenantId !== prior.tenantId))
                  throw new LocalDataError(409, '已确认银行卡付款的原订单不可换卡或付款方式');
                retainOrderField(row, prior, 'paymentId');
              } else if (!automatic && needsOrderCardCheck(row, prior)) {
                if (row.product === 'GPT' && typeof row.cardId === 'string' && row.cardId.startsWith('recharge:')) {
                  const card = cards.get(row.cardId);
                  if (!card?.active) throw new LocalDataError(409, '请选择当前可用的代充卡池银行卡');
                  row.paymentId = card.last4;
                  const fee = deriveCardIssueFee(row, prior, [...oldOrders, ...settledThisWrite], card);
                  if (fee) row.issueFeeSnapshot = fee;
                  else delete row.issueFeeSnapshot;
                  if (row.paidConfirmed) row.cardUsedAt = new Date().toISOString();
                } else if (row.product?.startsWith('Claude') && typeof row.cardId === 'string' && row.cardId.startsWith('tenant:')) {
                  const card = tenantCards.find((item) => item.id === row.cardId && item.tenantId === row.tenantId && item.active);
                  if (!card) throw new LocalDataError(409, '请选择当前认证人名下的银行卡');
                  row.paymentId = card.number.slice(-4);
                } else if (row.cardId || row.paidConfirmed) {
                  throw new LocalDataError(409, '请选择对应来源的银行卡');
                } else row.paymentId = '';
              } else if (!automatic && row.payment === '银行卡') {
                retainOrderField(row, prior, 'paymentId');
              }
              if (action !== snapshotAction) normalizePaymentEvidence(row, prior, automatic);
              if (row.payment === '银行卡' && row.paidConfirmed) settledThisWrite.push(row);
            }
          }
          const error =
            checkBankReturns(priorCommerce, commerce) ||
            checkOrderFinancialHistory(priorCommerce, commerce) ||
            checkFinanceSnapshots(priorCommerce, commerce, { action, verifyAutomaticSnapshot });
          if (error) throw new LocalDataError(409, error);
        }
        if (checksStock) {
          const error = checkStockDeliveries(priorCommerce, commerce, priorInventory, inventory, actor ?? localToolboxActor);
          if (error) throw new LocalDataError(409, error);
        }
        if (checksStock || incoming.has('appleBalance')) {
          const previous = current('appleBalance');
          const ledger = incoming.get('appleBalance') ??
            previous ?? {
              wallets: [],
              allocations: [],
              movements: [],
              refunds: []
            };
          const error = checkAppleLedger(
            previous,
            ledger,
            checksStock ? inventory : current('inventory'),
            checksStock ? commerce : current('commerce')
          );
          if (error) throw new LocalDataError(409, error);
        }
        const now = new Date().toISOString();
        if (inventory && (inventoryWrite || incoming.has('commerce'))) {
          const next = inventoryWrite ? inventory : structuredClone(inventory);
          const matches = inspectInventoryUsage(next, commerce, Date.parse(now));
          if (inventoryWrite?.action !== 'inventory_reconcile_usage') {
            for (const [id, match] of matches) {
              const prior = priorUsage.get(id);
              if (prior?.status === 'used' && !returnedBatches.has(match.claim?.batch.id) &&
                prior.evidence.accountId === match.evidence.accountId &&
                prior.evidence.orderId === match.evidence.orderId &&
                prior.evidence.registrationId === match.evidence.registrationId) matches.delete(id);
            }
          }
          if (applyInventoryUsage(matches, actor, new Date(now))) {
            const error = checkInventoryHistory(priorInventory, next);
            if (error) throw new LocalDataError(409, error);
            if (!inventoryWrite) writes.push({
              domain: 'inventory', version: readDocument('inventory').version,
              data: next, action: 'inventory_reconcile_usage'
            });
            inventory = next;
          }
        }
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
          result.push({ domain, version: next, data, ...(review.length && { usageReview: review }) });
        }
        return result;
      });
    },
    featureDocument(domain) {
      if (!orderFeatureDomains.has(domain)) throw new TypeError('未知订单附属资料');
      return readDocument(domain);
    },
    saveFeatureDocument(domain, version, data, { action, actor, targetId } = {}) {
      if (!orderFeatureDomains.has(domain)) throw new TypeError('未知订单附属资料');
      return writeTransaction(() => {
        if (readDocument(domain).version !== version) throw new LocalDataError(409, '资料已更新，请刷新后重试');
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
          jobKey, needs: ['等待核对成功回执']
        }))];
        if (rows.length === current.data.rows.length && scanOffset === current.data.scanOffset) return current.data;
        const data = { ...current.data, rows, scanOffset };
        const version = current.version + 1;
        put.run('order-sync', version, encrypt(key, 'order-sync', version, JSON.stringify(data)));
        return data;
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
          if (order && order.email.toLowerCase() === old.email.toLowerCase() && order.plan === old.plan) {
            const next = { ...old };
            if (!old.paidConfirmed && !old.paidAmount && !old.paidCurrency && order.paidConfirmed) {
              for (const field of ['paidAmount', 'paidCurrency', 'paidConfirmed']) next[field] = order[field];
              next.financialEvidence = [...(old.financialEvidence || []), ...order.financialEvidence];
            }
            if (!old.start && !old.expiry && order.start) {
              for (const field of ['start', 'expiry', 'rechargeCompletedAt']) next[field] = order[field];
            }
            if (!old.paymentId && order.paymentId) next.paymentId = order.paymentId;
            if (!old.cardId && order.cardId && next.paymentId === order.paymentId) next.cardId = order.cardId;
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
          const settings = readDocument('settings').data;
          changed = { ...order, id, orderNo, saleAmount: settings?.orderPrices?.GPT?.[order.plan]?.CNY || '' };
          data.orders.unshift(changed);
          result.orderNo = orderNo;
        }
        if (changed) {
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
        if (currentOrder?.issueFeeSnapshot && !currentOrder.issueFeeSnapshot.pending)
          result.needs = result.needs.filter((issue) => issue !== '首次开卡费待核对');
        const version = status.version + 1;
        const records = { ...status.data, since: status.data?.since ?? since,
          rows: [...previous.filter((item) => item.jobKey !== row.jobKey), result] };
        put.run('order-sync', version, encrypt(key, 'order-sync', version, JSON.stringify(records)));
        return result;
      });
    },
    audit: () => audit.all().map(readAuditRow),
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
    close: () => db.close()
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

export async function handleLocalBusiness(
  request,
  response,
  route,
  store,
  actor,
  { verifyRelayExtraction, verifyManagedMailbox, publicOrigin, readOrderCards } = {}
) {
  try {
    const domain = route.slice('/api/local/'.length);
    const origin = publicOrigin || `http://${request.headers.host}`;
    if (
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      throw new LocalDataError(403, '仅允许从本机页面访问');
    }
    if (domain === 'tools/mailbox-pool') {
      if (!['admin', 'super'].includes(actor?.role)) throw new LocalDataError(403, '只有管理员可以管理邮箱池');
      response.setHeader('Cache-Control', 'private, no-store');
      if (request.method === 'GET') return json(response, 200, store.loadManagedMailboxPool());
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从本机页面使用');
      if (request.method === 'POST') {
        const body = await readJson(request);
        return json(response, 200, store.copyManagedMailboxCode(body?.id, actor));
      }
      if (request.method === 'PUT')
        return json(response, 200, await store.saveVerifiedManagedMailboxPool(await readJson(request), actor, verifyManagedMailbox));
      throw new LocalDataError(405, '本机接口不支持此操作');
    }
    if (domain === savedTotpDomain || domain === savedTotpDomain + '/code') {
      if (!actor) throw new LocalDataError(401, '请先登录');
      response.setHeader('Cache-Control', 'private, no-store');
      if (domain === savedTotpDomain && request.method === 'GET')
        return json(response, 200, store.loadSavedTotp(actor));
      if (request.headers.origin !== origin) throw new LocalDataError(403, '仅允许从本机页面使用');
      if (domain === savedTotpDomain && request.method === 'PUT')
        return json(response, 200, await store.saveSavedTotp(await readJson(request), actor));
      if (domain === savedTotpDomain + '/code' && request.method === 'POST') {
        const body = await readJson(request);
        return json(response, 200, await store.useSavedTotp(body?.id, actor));
      }
      throw new LocalDataError(405, '本机接口不支持此操作');
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
        if (actor?.id) response.setHeader('X-ID-BitBrowser-Token-Storage', 'enabled');
        return json(response, 200, store.loadBitBrowserConnections(actor));
      }
      if (domain === bitBrowserAddressDomain) {
        const { searchParams } = new URL(request.url, origin);
        return json(response, 200, store.listBitBrowserAddresses(searchParams, actor));
      }
      if (domain === 'inventory') return json(response, 200, store.inventorySnapshot());
      return json(response, 200, domain === 'audit' ? store.audit() : store.load(domain));
    }
    if (request.method !== 'PUT') throw new LocalDataError(405, '本机接口不支持此操作');
    if (request.headers.origin !== origin) {
      throw new LocalDataError(403, '仅允许从本机页面保存');
    }
    const body = await readJson(request);
    if (domain === 'batch') {
      return json(response, 200, await saveHttpWrites(store, body, actor, verifyRelayExtraction, readOrderCards));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalDataError(400, '保存资料格式不正确');
    }
    if (domain === 'inventory/usage-correction') return json(response, 200, store.saveInventoryUsageCorrection(body, actor));
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
    const [entry, inventory] = await saveHttpWrites(store, [{ ...body, domain }], actor, verifyRelayExtraction, readOrderCards);
    return json(response, 200, {
      version: entry.version, data: entry.data,
      ...(entry.usageReview && { usageReview: entry.usageReview }),
      ...(inventory?.domain === 'inventory' && { inventory })
    });
  } catch (error) {
    if (response.destroyed) return;
    if (
      error instanceof LocalDataError ||
      error instanceof RelayClaimError ||
      error instanceof BitBrowserAddressError ||
      error instanceof BitBrowserConnectionError ||
      error instanceof SavedTotpError ||
      error instanceof MailboxPoolError
    )
      return json(response, error.status, { error: error.message });
    return json(response, 500, { error: '本机数据读写失败，请重试' });
  }
}
