import { inventoryOperationalStatus } from '../orders/order-opening.mjs';
import { listIdentity } from '../orders/order-list.mjs';

export const inventoryAccountTypes = ['gpt', 'claude', 'gemini', 'grok'];
export const inventoryMailboxTypes = ['google', 'microsoft'];
export const registrationPlatforms = [
  ['gpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['apple', 'Apple ID']
];
export const registrationAddress = value => String(value || '').trim().toLowerCase();
export const stockRegistration = row => inventoryAccountTypes.includes(row?.type) && row.source !== '客户提供' &&
  !['客户自有', 'customer'].includes(row.accountSource);
export const defaultInventorySettings = () => ({
  countries: ['马来西亚', '美国', '日本', '新加坡'], sources: ['自己注册', '线上购买', '客户提供'], hours: 72
});

export function normalizeInventoryAsset(asset) {
  asset.inventoryState ||= asset.used ? 'used' : 'available';
  asset.inventoryHistory ||= [];
  asset.usageLinks ||= [];
  asset.version ||= 1;
  if (!asset.createdAt && asset.importedAt) asset.createdAt = asset.importedAt;
  asset.health ||= 'normal';
  asset.status ||= '正常';
  asset.used = asset.inventoryState !== 'available';
  return asset;
}

export function inventoryIdentityIndex(accounts, registrationRecords) {
  const byIdentity = new Map(), accountsById = new Map(), stockByEmail = new Map(), registrations = new Map();
  const append = (index, key, row) => {
    if (index.has(key)) index.get(key).push(row);
    else index.set(key, [row]);
  };
  for (const asset of accounts) {
    let identities = byIdentity.get(asset.type);
    if (!identities) byIdentity.set(asset.type, identities = new Map());
    const key = registrationAddress(listIdentity(asset));
    identities.set(key, identities.has(key) ? null : asset);
    if (!accountsById.has(asset.id)) accountsById.set(asset.id, asset);
    if (stockRegistration(asset)) append(stockByEmail, registrationAddress(asset.email), asset);
  }
  for (const record of registrationRecords)
    if (record.state === '成功') append(registrations, record.assetId, record);
  return { byIdentity, accountsById, stockByEmail, registrations };
}

export function registrationProduct(value) {
  const key = registrationAddress(value);
  return ({ chatgpt: 'gpt', codex: 'gpt', 'apple id': 'apple' })[key] || key;
}

export function registeredPlatforms(asset, { registrations, accountsById }) {
  const found = new Set((registrations.get(asset.id) || []).map(row => registrationProduct(row.product)));
  for (const link of asset.usageLinks || []) {
    if (!['registration', 'manual-use'].includes(link.kind)) continue;
    found.add(registrationProduct(link.product));
    if (link.kind === 'registration' && link.accountId)
      found.add(registrationProduct(accountsById.get(link.accountId)?.type));
  }
  return registrationPlatforms.filter(([id]) => found.has(id));
}

export function registrationConflict(asset, platforms, { stockByEmail }, review) {
  if (review?.registrationConflict) return true;
  const known = new Set(platforms.map(([key]) => key).filter(key => key !== 'apple'));
  if (known.size > 1 || (asset.type === 'relay' && known.has('gemini'))) return true;
  const address = registrationAddress(asset.email);
  const related = address ? stockByEmail.get(address) || [] : [];
  return related.length > 1 || related.some(account => known.size && !known.has(account.type));
}

export function inventoryPlatformLabel(asset, index, review) {
  const platforms = registeredPlatforms(asset, index);
  if (registrationConflict(asset, platforms, index, review)) return '待核对';
  return platforms.map(([, label]) => label).join('、') ||
    (asset.inventoryState === 'used' ? '平台未登记' : '未登记');
}

export const historicallyOpened = asset => asset.type === 'claude' && asset.claudeHistory?.phase === 'opened';
export const displayInventoryState = asset => historicallyOpened(asset) ? 'used' : asset.inventoryState;
export const mailHealth = asset => ({ dead: '死号', unlocking: '解封中' }[asset.health] || asset.status || '未登记');
export const mailUse = asset => asset.type === 'microsoft' && asset.inventoryState === 'available'
  ? asset.mailboxUsage || 'unknown' : displayInventoryState(asset);

export function inventoryHealthTime(asset) {
  const label = asset.health === 'dead' ? '死号' : '解封中';
  const event = (asset.inventoryHistory || []).findLast(entry =>
    (entry.action === '健康状态变化' && entry.detail === asset.health) ||
    (entry.action === '归还' && String(entry.detail || '').endsWith(` · ${label}`)));
  return event?.time || asset.healthChangedAt || '历史未记录';
}

export function inventoryListTime(asset, tab) {
  const recorded = [asset.createdAt, asset.importedAt, asset.registered];
  if (tab === 'claimed') return [asset.claimedAt, ...recorded];
  if (tab === 'used') return [asset.actualUsedAt, asset.claudeHistory?.start, asset.usedAt, ...recorded];
  if (tab === 'dead' || tab === 'unlocking') return [inventoryHealthTime(asset), ...recorded];
  return recorded;
}

export function inventoryRegistrationTime(asset) {
  return String(asset.registered || '').trim() ||
    (asset.claudeHistory ? '' : asset.createdAt || asset.importedAt || '');
}

export function inventoryRegistrationInstant(value) {
  const time = String(value || '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) return Date.parse(time + 'T00:00+08:00');
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(time)) return Date.parse(time + '+08:00');
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(time) ? Date.parse(time) : NaN;
}

export function inventoryAge(asset, at) {
  const date = inventoryRegistrationInstant(inventoryRegistrationTime(asset));
  return Number.isFinite(date) && date <= at ? Math.floor((at - date) / 3_600_000) : null;
}

export function inventoryCanExtract(asset, { review, pendingDelivery, agingHours, at }) {
  const customerOwned = ['gemini', 'grok'].includes(asset.type) &&
    (asset.source === '客户提供' || ['客户自有', 'customer'].includes(asset.accountSource));
  if (historicallyOpened(asset) || customerOwned || pendingDelivery || asset.type === 'relay') return false;
  const age = asset.type === 'claude' ? inventoryAge(asset, at) : null;
  return asset.inventoryState === 'available' && !review && asset.health === 'normal' &&
    inventoryOperationalStatus(asset) === '正常' && (asset.type !== 'claude' || (age !== null && age >= agingHours));
}

export function inventoryMatches(asset, { tab, query, country, status, usage }, { mail, platformLabel }) {
  const state = mail ? mailUse(asset) : displayInventoryState(asset);
  const inTab = tab === 'all' || (['dead', 'unlocking'].includes(tab)
    ? asset.health === tab : (tab === 'used' || asset.health === 'normal') && state === tab);
  if (!inTab || (country && asset.country !== country) ||
      (status && (mail ? mailHealth(asset) : asset.status) !== status) ||
      (mail && usage && state !== usage)) return false;
  return !query || `${listIdentity(asset)} ${asset.email || ''} ${asset.notes || ''} ${asset.purpose || ''} ${platformLabel || ''} ${asset.type === 'microsoft' ? asset.auxiliary || '' : ''}`
    .toLowerCase().includes(query.toLowerCase());
}

export function claudeInventoryIssue(order, index) {
  const identity = registrationAddress(order.email);
  if (!identity || ['客户自有', 'customer'].includes(order.accountSource)) return '';
  const asset = order.accountId ? index.accountsById.get(order.accountId) : index.byIdentity.get('claude')?.get(identity);
  if (asset?.type !== 'claude' || registrationAddress(listIdentity(asset)) !== identity ||
      (order.platformAccountId && asset.platformAccountId && order.platformAccountId !== asset.platformAccountId)) return '';
  if (asset.health === 'dead' || (!asset.health && (asset.status === '死号' || asset.claudeHistory?.phase === 'dead')))
    return '死号';
  if (asset.health === 'unlocking' || (!asset.health && asset.status === '解封中')) return '解封中';
  if (asset.status === '封控中') return '封控中';
  return inventoryOperationalStatus(asset) === '冻结' ? '冻结' : '';
}
