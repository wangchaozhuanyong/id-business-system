import { createDecipheriv } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { productionDataPaths } from '../production-data.mjs';
import { managedMailboxDomain, mailboxPoolMetadata } from '../tools/mailbox-pool.mjs';

const platforms = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft', gpt: 'GPT',
  claude: 'Claude', relay: 'Apple 隐藏邮箱' };
const use = { available: '未使用', claimed: '已提取待使用', used: '已实际使用' };
const health = { dead: '死号', unlocking: '解封中', normal: '正常' };
const yesNo = (value) => value === true ? '是' : value === false ? '否' : '';
const tags = (value) => Array.isArray(value) ? value.filter(item => typeof item === 'string').join('、') : '';
const platform = (row) => platforms[row.type ?? row.provider] ?? row.type ?? row.provider;
const rowsOf = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

// Column order is stable. Review and append new business fields here before exporting them.
export const reportColumns = {
  邮箱管理: ['来源', '记录编号', '邮箱', '平台', '状态', '使用状态', '国家地区', '来源渠道',
    '登记时间', '最近更新', '查询到期'],
  账号管理: ['记录编号', '账号邮箱', '平台', '注册国家', '注册城市', '账号状态', '使用状态',
    '来源渠道', '注册时间', '录入人', '录入时间', '最近操作人', '最近操作时间', '苹果 ID 余额', '余额币种'],
  订单管理: ['记录编号', '订单编号', '客户编号', '客户', '订单邮箱', '产品', '套餐', '业务类型',
    '归属人', '支付方式', '代付金额', '代付币种', '付款已确认', '售卖金额', '售卖币种',
    '实收已确认', '订阅开始', '到期时间', '业务状态', '退款笔数', '录入时间', '最近更新', '资料来源', '代充核对状态'],
  客户管理: ['客户编号', '姓名', '联系电话', '微信', 'QQ', 'WhatsApp', 'Telegram',
    '来源渠道', '客户标签', '录入人', '录入时间', '最近更新', '资料类型', '归属人', '状态']
};

export function projectBusinessReports({ inventory, commerce, managedMailboxes, appleBalance, orderSync }) {
  const customers = rowsOf(commerce?.customers);
  const customerNames = new Map(customers.map(row => [row.id, row.name]));
  const wallets = new Map(rowsOf(appleBalance?.wallets).map(row => [row.id, row]));
  const orders = rowsOf(commerce?.orders);
  const syncRows = rowsOf(orderSync?.rows);
  const syncByOrder = new Map(syncRows.filter(row => row.orderNo).map(row => [row.orderNo, row]));
  const orderNos = new Set(orders.map(row => row.orderNo).filter(Boolean));
  const mailboxInventory = rowsOf(inventory?.mailboxes);
  const appleIds = mailboxInventory.filter(row => row.type === 'apple');
  const status = (row) => row?.excluded ? '已排除' : row?.needs?.length ? '待核对' : row?.orderNo ? '已同步' : '';
  const projected = {
    邮箱管理: [
      ...mailboxInventory.filter(row => row.type !== 'apple').map(row => ['库存邮箱', row.id, row.email, platform(row),
        health[row.health] ?? row.status, use[row.inventoryState], row.country, row.source,
        row.createdAt || row.importedAt, row.lastOperatedAt]),
      ...managedMailboxes.map(row => ['托管邮箱池', row.id, row.email, platform(row),
        row.authFailed ? '授权失效' : row.active ? '启用' : '停用', '', '', '', '', row.updatedAt, row.expiresAt])
    ],
    账号管理: [...rowsOf(inventory?.accounts), ...appleIds].map(row => [row.id, row.email, platform(row),
      row.country, row.city, health[row.health] ?? row.status, use[row.inventoryState], row.source,
      row.registered || row.createdAt || row.importedAt, row.createdBy, row.createdAt,
      row.lastOperatedBy, row.lastOperatedAt, wallets.get(row.id)?.balance, wallets.get(row.id)?.currency]),
    订单管理: [
      ...orders.map(row => [row.id, row.orderNo, row.customerId, customerNames.get(row.customerId),
        row.email, row.product, row.plan, row.businessType, row.owner || row.createdBy,
        row.payment, row.paidAmount, row.paidCurrency, yesNo(row.paidConfirmed), row.saleAmount,
        row.saleCurrency, yesNo(row.receiptConfirmed), row.start, row.expiry, row.cancelled ? '已撤单' : '正常',
        rowsOf(row.refunds).length, row.createdAt, row.updatedAt, row.source || '业务订单',
        status(syncByOrder.get(row.orderNo))]),
      ...syncRows.filter(row => !orderNos.has(row.orderNo)).map(row => [
        '代充任务:' + row.jobKey, row.orderNo, '', '', row.email, 'GPT', row.plan, '', '', '',
        row.paidAmount, row.paidCurrency, '', '', '', '', row.start, row.expiry, '', '', '', '',
        '线上代充核对', status(row)
      ])
    ],
    客户管理: [
      ...customers.map(row => [row.id, row.name, row.phone, row.wechat, row.qq,
        row.whatsapp, row.telegram, row.source, tags(row.tags), row.createdBy, row.createdAt,
        row.updatedAt, '客户']),
      ...rowsOf(commerce?.tenants).map(row => [row.id, row.name, row.phone, row.wechat, row.qq,
        row.whatsapp, row.telegram, row.source, tags(row.tags), row.createdBy, row.createdAt,
        row.updatedAt, '租户', row.owner, row.active === false ? '停用' : '启用'])
    ]
  };
  return Object.fromEntries(Object.entries(reportColumns).map(([title, columns]) =>
    [title, [columns, ...projected[title].map(row => columns.map((_, index) => text(row[index])))]]));
}

function decrypt(key, { domain, version, payload }) {
  // Match the independent store's authenticated document format.
  const bytes = Buffer.from(payload);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${domain}:${version}`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
}

export async function openReportSource(dataDir) {
  const { databasePath } = await productionDataPaths(dataDir);
  const identity = await lstat(databasePath);
  const keyFile = await open(databasePath + '.key', constants.O_RDONLY | constants.O_NOFOLLOW);
  let key;
  try {
    const info = await keyFile.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size !== 32) throw new Error('SHEETS_SOURCE_KEY_INVALID');
    key = await keyFile.readFile();
  } finally {
    await keyFile.close();
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
    const revision = database.prepare('PRAGMA data_version');
    const select = database.prepare(`SELECT domain, version, payload FROM business_document
      WHERE domain IN ('inventory', 'commerce', 'appleBalance', 'order-sync', ?)`);
    return {
      async revision() {
        const current = await lstat(databasePath);
        if (current.dev !== identity.dev || current.ino !== identity.ino)
          throw new Error('SHEETS_SOURCE_REPLACED');
        return revision.get().data_version;
      },
      read() {
        // A single statement reads the report documents from one committed SQLite snapshot.
        const docs = new Map(select.all(managedMailboxDomain).map(row => [row.domain, {
          version: row.version, data: decrypt(key, row)
        }]));
        return projectBusinessReports({
          inventory: docs.get('inventory')?.data,
          commerce: docs.get('commerce')?.data,
          appleBalance: docs.get('appleBalance')?.data,
          orderSync: docs.get('order-sync')?.data,
          managedMailboxes: mailboxPoolMetadata(docs.get(managedMailboxDomain) ?? { version: 0 }).items
        });
      },
      close() {
        key.fill(0);
        database.close();
      }
    };
  } catch (error) {
    key.fill(0);
    database?.close();
    throw error;
  }
}
