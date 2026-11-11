import { toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { aiRegistrationProduct } from './inventory-registration.mjs';

const platforms = new Map([
  ['gpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['apple', 'Apple ID']
]);
const list = value => Array.isArray(value) ? value : [];
const productKey = value => {
  const key = String(value || '').trim().toLowerCase();
  return ({ chatgpt: 'gpt', codex: 'gpt', 'apple id': 'apple' })[key] || key;
};

// A platform-only mark supplements confirmed use. It does not invent an account,
// a registration date or another extraction, and cannot rewrite earlier evidence.
export function prepareMailboxPlatformMarks(previous, next, action, actor, now = new Date()) {
  const before = new Map([...list(previous?.mailboxes), ...list(previous?.accounts)].map(row => [row?.id, row]));
  const accounts = new Map(list(previous?.accounts).map(row => [row?.id, row]));
  const time = toV2DateTimeInput(now).replace('T', ' ');
  for (const row of [...list(next.mailboxes), ...list(next.accounts)]) {
    const prior = before.get(row?.id);
    const added = list(row?.usageLinks).slice(list(prior?.usageLinks).length);
    const marks = added.filter(link => link?.kind === 'registration' && !link.registrationId && !link.accountId);
    if (!marks.length) continue;
    if (action !== 'inventory_registration_result' || !prior ||
        !['google', 'relay', 'microsoft'].includes(prior.type) || row.type !== prior.type ||
        row.email !== prior.email || (prior.inventoryState || (prior.used ? 'used' : 'available')) !== 'used' ||
        row.inventoryState !== 'used')
      return '注册平台补录仅适用于已使用邮箱，请从标记注册平台入口登记';
    if (['actualUsedAt', 'claimedAt', 'claimId', 'claimBatchId'].some(key => row[key] !== prior[key]))
      return '补录注册平台必须保留原使用时间和领用关联';
    const known = new Set(list(previous.registrationRecords)
      .filter(record => record.assetId === row.id && record.state === '成功')
      .map(record => productKey(record.product)));
    for (const link of list(prior.usageLinks)) {
      if (!['registration', 'manual-use'].includes(link.kind)) continue;
      known.add(productKey(link.product));
      if (link.kind === 'registration' && link.accountId) known.add(productKey(accounts.get(link.accountId)?.type));
    }
    for (const mark of marks) {
      if (!platforms.has(mark.product)) return '请选择有效的注册平台';
      if (known.has(mark.product)) return '该邮箱已登记此注册平台，请勿重复保存';
      if (prior.type === 'relay' && !['gpt', 'claude', 'grok'].includes(mark.product))
        return '隐藏邮箱仅可登记 ChatGPT、Claude 或 Grok';
      if (aiRegistrationProduct(mark.product) && [...known].some(aiRegistrationProduct))
        return '该邮箱已有注册平台，请核对原账号';
      known.add(mark.product);
      mark.label = `人工登记 · 已注册 ${platforms.get(mark.product)}`;
      mark.time = time;
    }
    // Relay rows use the same real session identity for this manual operation.
    if (actor?.id && actor.name) {
      Object.assign(row, { lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time });
      for (const event of list(row.inventoryHistory).slice(list(prior.inventoryHistory).length))
        Object.assign(event, { actorId: actor.id, actor: actor.name, time });
    }
  }
}
