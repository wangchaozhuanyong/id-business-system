// Synthetic data for offline visual acceptance only.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './offline-design.mjs';
import {createOrderSnapshot} from '../../modules/finance/accounting.mjs';
export const clock = Date.parse('2026-11-13T06:30:00Z');
const instant = (day = 0, minute = 0) => new Date(clock + day * 86400000 - minute * 60000).toISOString();
const displayDate = (day = 0, minute = 0) => new Date(clock + 8 * 3600000 + day * 86400000 - minute * 60000).toISOString().replace('T', ' ').slice(0, 16);
const base = JSON.parse(await readFile(path.join(root, 'docs/audits/2026-11-06-design-review/visual-fixtures.json')));
export const actor = { id: 'visual-admin', name: '超级管理员', role: 'super' };
const names = ['林予安', '陈知远', '苏沐', '许星禾', '周景川', '沈清和', '顾言', '江雨桐', '宋书宁', '陆以南', '白亦舟', '程向晚'];
const identifiers = ['lin.yuan', 'chen.zy', 'su.mu', 'xu.xinghe', 'zhou.jc', 'shen.qh', 'gu.yan', 'jiang.yt', 'song.sn', 'lu.yn', 'bai.yz', 'cheng.xw'];
const customers = Array.from({ length: 48 }, (_, i) => ({
  id: 'visual-customer-' + i, name: names[i % names.length] + (i >= names.length ? ' ' + (Math.floor(i / names.length) + 1) : ''),
  email: identifiers[i % names.length] + (i >= names.length ? i : '') + '@example.test',
  wechat: 'demo_' + identifiers[i % names.length].replace('.', '_') + String(i + 21), active: true,
  createdAt: instant(-Math.floor(i / 12), i * 13), tags: [], source: '客户推荐', version: 1,
  notes: ['按月续订', '设计工作室', '', '已发送开通说明', '企业订阅', ''][i % 6]
}));
const orders = customers.map((customer, i) => {
  const plan = ['Plus', 'Plus', 'Pro 100', 'Pro 200', 'Plus', 'Plus'][i % 6];
  const order = {
    ...base.commerce.data.orders[0], id: 'visual-order-' + i, orderNo: 'OD261113' + String(48 - i).padStart(4, '0'),
    email: customer.email, customerId: customer.id, plan, product: 'GPT',
    payment: '银行卡', paymentId: 'DEMO-' + String(i + 1).padStart(4, '0'), cardId: 'visual-card-' + i,
    cardTypeName: '订阅业务卡', cardTypeId: 'visual-type', proMaterialMode: 'manual',
    proCardNumber: '', proCardSerial: '演示资料', accountSource: '客户自有', businessType: i % 5 ? '续费' : '首次开通',
    paidAmount: plan === 'Plus' ? '983' : plan === 'Pro 100' ? '4899' : '9799', paidCurrency: 'PHP',
    saleAmount: plan === 'Plus' ? '138' : plan === 'Pro 100' ? '758' : '1458', saleCurrency: 'CNY',
    createdAt: instant(-Math.floor(i / 16), i * 11), start: displayDate(-Math.floor(i / 16), i * 11), expiry: displayDate(30 - Math.floor(i / 16), i * 11),
    ownerId: actor.id, owner: actor.name, createdById: actor.id, createdBy: actor.name,
    notes: customer.notes, wechat: customer.wechat, source: i % 4 === 2 ? '线上代充' : '管理员手工',
    refunds: [], bankReturns: [], corrections: [], compensations: [], cancellationEvents: [],
    costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' },
    issueFeeSnapshot: { applied: true, cardId: 'visual-card-' + i, amountUsd: '0.5' }
  };
  order.fxSnapshot = createOrderSnapshot({ source: '离线合成汇率', at: instant(-10), expiresAt: instant(1), rates: { MYR: '1.6', USD: '7.2', PHP: '0.117' } }, order, clock);
  return order;
});
const accounts = Array.from({ length: 86 }, (_, i) => ({
  ...base.inventory.data.accounts.find(row => row.type === 'gpt'), id: 'visual-account-' + i, type: 'gpt',
  email: (i < 12 ? identifiers[i] : 'studio.' + String(i + 1).padStart(3, '0')) + '@example.test',
  emailType: i % 4 === 1 ? 'relay' : 'google', password: '演示密码', totp: i % 4 ? '未录入' : '演示密钥',
  country: ['美国', '美国', '日本', '新加坡'][i % 4], city: ['洛杉矶', '纽约', '东京', '新加坡'][i % 4],
  health: i >= 82 ? 'dead' : 'normal', status: i >= 82 ? '死号' : '正常',
  inventoryState: i >= 68 && i < 82 ? 'claimed' : 'available', used: i >= 68 && i < 82,
  registered: displayDate(-30, i * 17), createdAt: displayDate(-3, i * 9),
  createdBy: '管理员', lastOperatedBy: '管理员', lastOperatedAt: instant(-1, i * 8).replace('T', ' ').slice(0, 16),
  acquisitionMethod: i % 4 ? 'self_registered' : 'purchased', device: '业务工作区 ' + (i % 5 + 1),
  source: i % 4 ? '内部注册' : '业务采购',
  notes: ['续费备用', '客户交付', '标准库存', '', '日常业务'][i % 5], notes2: '', usageLinks: [], history: [], inventoryHistory: []
}));
export const fixture = {
  commerce: { version: 1, data: { ...base.commerce.data, customers: [...customers, { ...customers[0], id: 'visual-draft-customer', name: '叶知夏', email: 'ye.zhixia@example.test', wechat: 'demo_yezhixia' }], orders, tenants: [] } },
  inventory: { version: 1, data: { mailboxes: [], accounts, batches: [] } },
  settings: base.settings,
  'auth/session': { actor, configured: true }, 'auth/order-owners': { items: [actor] }, 'auth/display-names': { items: [actor] },
  'card-types': { version: 1, items: [{ id: 'visual-type', name: '订阅业务卡', active: true }], assignments: {} }
};
