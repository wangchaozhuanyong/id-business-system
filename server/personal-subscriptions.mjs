import { randomUUID } from 'node:crypto';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { pendingInventoryClaim } from './inventory-usage.mjs';

export const personalPlans = {
  Gemini: ['Google AI Plus', 'Google AI Pro', 'Google AI Ultra 5x', 'Google AI Ultra 20x'],
  Grok: ['The X Subscription Plus', 'The X Subscription Premium', 'The X Subscription Super',
    'The X Subscription Ultra', 'SuperGrok Lite', 'SuperGrok', 'SuperGrok Plus', 'SuperGrok Heavy',
    'X Premium', 'X Premium+']
};
export const personalProduct = product => Object.hasOwn(personalPlans, product);
export const personalStock = type => type === 'gemini' || type === 'grok';
export const stockTypeForProduct = product => ({
  GPT: 'gpt', 'Claude Pro': 'claude', 'Claude Max': 'claude', Gemini: 'gemini', Grok: 'grok'
})[product] || '';
export const subscriptionSeries = order => order.product === 'Gemini' ? 'google_ai'
  : order.plan?.startsWith('The X Subscription ') ? 'x_subscription'
    : order.plan?.startsWith('SuperGrok') ? 'supergrok' : 'x_premium';
export const targetKey = row => {
  const email = String(row?.email || '').trim().toLowerCase();
  const handle = String(row?.xHandle || '').trim().toLowerCase();
  return row?.loginMethod === 'x' && handle ? 'x:' + handle : email ? 'email:' + email : handle ? 'x:' + handle : '';
};
export const sameTarget = (a, b) => !!targetKey(a) && targetKey(a) === targetKey(b) &&
  (!a.platformAccountId || !b.platformAccountId || a.platformAccountId === b.platformAccountId);
export const samePersonalSubscription = (a, b) => a.product === b.product &&
  subscriptionSeries(a) === subscriptionSeries(b) && sameTarget(a, b);
export const personalDelivery = order => order?.businessType === '成品交付' &&
  (!personalProduct(order.product) || order.entitlementStatus === 'active');
const personalStockOwner = row => row.source !== '客户提供' && !['客户自有', 'customer'].includes(row.accountSource);
const nonempty = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\r\n]/.test(value);
const emailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const xFormat = /^@[a-z0-9_]{1,15}$/i;
const list = value => Array.isArray(value) ? value : [];
const inventoryState = row => row.inventoryState || (row.used ? 'used' : 'available');
const time = value => typeof value === 'string' && value
  ? /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) :
    parseV2DateTimeInput(value.replace(' ', 'T'))?.getTime() ?? NaN : NaN;

function targetError(row, gemini) {
  if (typeof row.email !== 'string' || (row.email && (!nonempty(row.email, 254) || !emailFormat.test(row.email)))) return '请填写有效订阅邮箱';
  if (row.xHandle && (typeof row.xHandle !== 'string' || !xFormat.test(row.xHandle))) return '请填写有效的 X @账号';
  if (gemini && (!row.email || row.xHandle || row.loginMethod !== 'google')) return 'Gemini 需记录实际 Google 账号';
  if (!gemini && (!targetKey(row) || !['email', 'google', 'apple', 'x'].includes(row.loginMethod) ||
    (row.loginMethod === 'x' && !row.xHandle) || (row.loginMethod !== 'x' && !row.email)))
    return '请核对 Grok 登录方式及实际账号';
  if (row.platformAccountId && !nonempty(row.platformAccountId, 120)) return '平台账号编号无效';
  if (row.xLinkState && (!['unknown', 'linked', 'unlinked'].includes(row.xLinkState) ||
    (row.xLinkState === 'linked' && !row.xHandle))) return '请核对 X 账号绑定状态';
}

export function personalOrderError(order, prior, orders, customers) {
  if (!personalProduct(order.product)) return;
  const identity = targetError(order, order.product === 'Gemini');
  if (identity) return identity;
  if (order.taskId || order.taskEvidenceId) return '个人订阅请登记手工订单';
  if (customers && !customers.some(row => row.id === order.customerId)) return '请选择订单客户';
  if (!personalPlans[order.product].includes(order.plan) || !['首次开通', '续费', '成品交付'].includes(order.businessType))
    return '请选择对应产品的可售套餐与业务类型';
  if (['tenantId', 'verifier', 'verifierPhone', 'phone'].some(field => order[field]) ||
      (order.proMaterialMode && !['manual_card', 'pool_card'].includes(order.proMaterialMode)) ||
    (order.kyc && order.kyc !== '未认证')) return '认证人与租户资料仅适用于 Claude';
  const series = subscriptionSeries(order);
  if (order.subscriptionSeries !== series) return '订阅系列与套餐不匹配';
  if (series === 'x_premium' && !order.xHandle) return 'X Premium 需记录实际订阅的 @账号';
  if (!['银行卡', '苹果内购'].includes(order.payment) ||
      (series === 'x_subscription' && order.payment !== '银行卡') ||
      (order.payment !== '苹果内购' && order.appleIdId))
    return '充值方式与套餐或付款资源不匹配';
  if (order.billingChannel && (!['web', 'web_apple_pay', 'google_play', 'app_store'].includes(order.billingChannel) ||
      (order.billingChannel === 'app_store') !== (order.payment === '苹果内购') ||
      (series === 'x_subscription' && !['web', 'web_apple_pay'].includes(order.billingChannel))))
    return '购买渠道与付款资源不匹配，请核对原账单';
  if (!['pending', 'active', 'failed'].includes(order.entitlementStatus) ||
    (order.autoRenew && !['unknown', 'on', 'off'].includes(order.autoRenew)) ||
    (order.billingCycle && !['month', 'year', 'other'].includes(order.billingCycle))) return '请核对权益状态与订阅周期';
  if ((order.billingCountry && !nonempty(order.billingCountry, 100)) ||
      (order.billingReceipt && !nonempty(order.billingReceipt, 160)) ||
      (order.nextChargeAt && !Number.isFinite(time(order.nextChargeAt)))) return '请核对账单地区、编号或下次扣款日';
  if (order.paidConfirmed && (order.payment === '苹果内购' ? !order.appleIdId || order.paidCurrency !== 'USD'
      : order.proMaterialMode !== 'manual_card' && !/^recharge:.+/.test(order.cardId || ''))) return '请核对实际付款资源和币种';
  if (order.paidConfirmed && order.product === 'Gemini' && order.payment === '苹果内购' &&
      order.appleGoogleVerified !== true) return '请核对付款 Apple ID 对应的 Google 账号';
  if (order.appleOriginalReceipt && (!nonempty(order.appleOriginalReceipt, 160) ||
      order.payment !== '苹果内购' || order.businessType !== '续费' ||
      order.appleOriginalReceipt.trim().toLowerCase() === String(order.billingReceipt || '').trim().toLowerCase()))
    return '请填写与本次交易不同的旧订阅交易编号';
  if (order.receiptConfirmed && !/^\d{1,16}(?:\.\d{1,4})?$/.test(order.saleAmount || ''))
    return '请登记实际实收金额';
  if ((order.start && !Number.isFinite(time(order.start))) ||
      (order.expiry && !(time(order.expiry) > time(order.start))) ||
      (order.entitlementStatus === 'active' && !(time(order.expiry) > time(order.start))))
    return '确认权益前请填写平台实际开通及到期时间';
  if (prior?.entitlementStatus === 'active' && order.entitlementStatus !== 'active') return '已核实的开通历史须保留';
  if (prior && (prior.paidConfirmed || prior.entitlementStatus === 'active') &&
      (!sameTarget(order, prior) || prior.plan !== order.plan))
    return '已确认订单的订阅目标与套餐须保留';
  // The shared order policy validates bank-card edits against the original correction snapshot.
  if (prior?.paidConfirmed && (prior.payment !== order.payment ||
      (prior.billingChannel ?? '') !== (order.billingChannel ?? '') ||
      (prior.billingReceipt ?? '') !== (order.billingReceipt ?? '') ||
      (prior.appleIdId ?? '') !== (order.appleIdId ?? '') ||
      (prior.payment !== '银行卡' && (prior.cardId ?? '') !== (order.cardId ?? ''))))
    return '已确认订单的原账单与付款资源须保留';
  if (order.billingReceipt && orders.some(row => row.id !== order.id && personalProduct(row.product) &&
      (['web', 'web_apple_pay'].includes(row.billingChannel) ? row.product === order.product &&
        ['web', 'web_apple_pay'].includes(order.billingChannel) : row.billingChannel === order.billingChannel) &&
      String(row.billingReceipt || '').trim().toLowerCase() === order.billingReceipt.trim().toLowerCase()))
    return '原渠道交易编号已登记，请继续处理原订单';
  if (prior?.previousOrderId && prior.previousOrderId !== order.previousOrderId)
    return '原续费订单关联须保留';
  if (order.previousOrderId) {
    const previous = orders.find(row => row.id === order.previousOrderId);
    if (order.businessType !== '续费' || !previous || previous.id === order.id ||
        previous.customerId !== order.customerId || !samePersonalSubscription(previous, order) ||
        previous.entitlementStatus !== 'active') return '请核对本次续费对应的原订单';
  }
  if (order.previousSubscriptionOrderId) {
    const previous = orders.find(row => row.id === order.previousSubscriptionOrderId);
    const sameX = previous?.xHandle && order.xHandle && previous.xHandle.toLowerCase() === order.xHandle.toLowerCase();
    if (!previous || previous.id === order.id || previous.product !== 'Grok' || previous.cancelled ||
      previous.customerId !== order.customerId || series !== 'x_subscription' ||
      subscriptionSeries(previous) === series || (!sameTarget(previous, order) && !sameX) ||
      !['unknown', 'on', 'off'].includes(order.previousAutoRenew))
      return '请核对同一客户的原 Grok 订阅与续费状态';
  } else if (order.previousAutoRenew && order.previousAutoRenew !== 'unknown') return '请选择原 Grok 订阅后登记续费状态';
}

export function preparePersonalInventory(previous, next, action, actor, now = new Date(), previousUsage = new Map()) {
  const oldAccounts = new Map(list(previous?.accounts).map(row => [row.id, row]));
  const oldMail = new Map(list(previous?.mailboxes).map(row => [row.id, row]));
  const nextMail = new Map(list(next.mailboxes).map(row => [row.id, row]));
  const personal = list(next.accounts).filter(row => personalStock(row.type));
  if (list(next.mailboxes).some(row => personalStock(row.type))) return '请在对应产品的账号管理登记资料';
  const addresses = new Set();
  const platformIds = new Set();
  const sources = new Set();
  const records = [];
  const stamp = toV2DateTimeInput(now).replace('T', ' ');
  for (const row of personal) {
    const old = oldAccounts.get(row.id);
    if (old && (!sameTarget(old, row) || (old.platformAccountId && row.platformAccountId !== old.platformAccountId) ||
        personalStockOwner(old) !== personalStockOwner(row) || (row.sourceMailboxId || '') !== (old.sourceMailboxId || '') ||
        (row.sourceClaimId || '') !== (old.sourceClaimId || ''))) return '账号标识和来源库存创建后须保留';
    const issue = targetError(row, row.type === 'gemini');
    if (issue) return issue;
    const identity = row.type + ':' + targetKey(row);
    const platform = row.platformAccountId && row.type + ':' + row.platformAccountId;
    if (addresses.has(identity) || (platform && platformIds.has(platform))) return '相同产品中已有该账号';
    addresses.add(identity);
    if (platform) platformIds.add(platform);
    if (!nonempty(row.source, 200) || !['正常', '冻结', '封控中'].includes(row.status))
      return '请核对账号来源与状态';
    if (old) {
      if (inventoryState(old) !== 'used' && inventoryState(row) === 'used' && action !== 'inventory_order_sale')
        return '产品账号请通过对应的成品交付登记实际使用';
      continue;
    }
    if (!['inventory_create', 'inventory_import'].includes(action) || inventoryState(row) !== 'available')
      return '请从对应产品账号库存登记来源与状态';
    if (!row.sourceMailboxId) {
      if (row.sourceClaimId) return '缺少原领用邮箱';
      continue;
    }
    const mailbox = oldMail.get(row.sourceMailboxId);
    const saved = nextMail.get(row.sourceMailboxId);
    if (!personalStockOwner(row) || !actor?.id || !mailbox || !saved ||
        !['google', 'relay'].includes(mailbox.type) || mailbox.relayDeleted || saved.relayDeleted ||
        mailbox.email?.toLowerCase() !== row.email?.toLowerCase() || saved.email !== mailbox.email ||
        saved.type !== mailbox.type || inventoryState(saved) !== inventoryState(mailbox) ||
        (mailbox.health || 'normal') !== 'normal' || (mailbox.status || '正常') !== '正常' ||
        (saved.health || 'normal') !== 'normal' || (saved.status || '正常') !== '正常' ||
        inventoryState(mailbox) === 'used' || list(mailbox.usageLinks).length || sources.has(mailbox.id) ||
        previousUsage.has(mailbox.id) ||
        list(next.registrationRecords).some(record => record.assetId === mailbox.id && record.state === '待核对'))
      return '来源邮箱已变化或已有实际使用，请重新核对';
    const claim = pendingInventoryClaim(previous, mailbox);
    const savedClaim = pendingInventoryClaim(next, saved);
    if (inventoryState(mailbox) === 'claimed' && (!claim || claim.item.id !== row.sourceClaimId ||
        claim.batch.actorId !== actor.id || claim.batch.kind !== 'mail' || claim.item.orderId ||
        claim.item.taskId || claim.item.registrationId || savedClaim?.item.id !== claim.item.id))
      return '请使用本人尚未完成的原邮箱领用批次';
    if (inventoryState(mailbox) !== 'claimed' && (mailbox.type === 'relay' || row.sourceClaimId))
      return '苹果隐藏邮箱请先从已核验的库存领用';
    const purpose = /^注册\s*(GPT|Claude|Gemini|Grok)$/i.exec(claim?.batch.purpose || '')?.[1]?.toLowerCase();
    if (purpose && purpose !== row.type) return '原领用用途与本次注册产品不一致';
    sources.add(mailbox.id);
    records.push({ id: randomUUID(), assetId: mailbox.id, email: mailbox.email,
      product: row.type === 'gemini' ? 'Gemini' : 'Grok', state: '成功', accountId: row.id,
      createdById: actor.id, createdBy: actor.name, createdAt: stamp, actorId: actor.id, actor: actor.name, time: stamp });
  }
  const knownRecords = new Set(list(previous?.registrationRecords).map(row => row.id));
  if (list(next.registrationRecords).some(row => !knownRecords.has(row.id) &&
      ['gemini', 'grok'].includes(String(row.product || '').toLowerCase())))
    return '请通过产品账号登记来源邮箱的使用记录';
  if (records.length) next.registrationRecords.push(...records);
}
