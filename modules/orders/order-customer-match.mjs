import {
  orderPhoneKey, splitOrderPhone, validOrderPhone,
  orderWhatsAppKey, splitOrderWhatsApp, validOrderWhatsApp
} from './order-whatsapp.mjs';

export function contactKey(text, channel) {
  const normalized = String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (channel === 'telegram') return normalized.replace(/^@/, '');
  if ((channel === 'phone' || channel === 'whatsapp') && /^\+?[\d\s().-]+$/.test(normalized))
    return normalized.replace(/[\s().-]/g, '');
  return normalized;
}

export const orderCustomerCalibrateAction = '新增订单并校准客户';
const channels = ['wechat', 'phone', 'qq', 'whatsapp', 'telegram'];
const customerFields = ['name', ...channels, 'source', 'tags'];
const phoneChannels = {
  phone: { key: orderPhoneKey, split: splitOrderPhone, valid: validOrderPhone },
  whatsapp: { key: orderWhatsAppKey, split: splitOrderWhatsApp, valid: validOrderWhatsApp }
};
const identityKey = (key, value) => phoneChannels[key]?.key(value) ?? contactKey(value, key);

export function hasInlineOrderCustomerContact(profile) {
  return channels.some((key) => {
    const value = profile?.[key];
    if (typeof value !== 'string') return false;
    const contact = identityKey(key, value);
    const phone = phoneChannels[key];
    if (!phone) return Boolean(contact);
    const { national } = phone.split(contact);
    return Boolean(national && national !== '+');
  });
}

function validProfileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.entries(input).every(([key, value]) => {
    if (!customerFields.includes(key)) return false;
    if (key === 'tags') return Array.isArray(value) && value.length <= 20 &&
      value.every(tag => typeof tag === 'string' && Boolean(tag.trim()) && tag.length <= 40 && !/[\r\n]/.test(tag)) &&
      new Set(value).size === value.length;
    return typeof value === 'string' && value.length <= (key === 'name' ? 80 : 60) &&
      !/[\r\n]/.test(value) && (!phoneChannels[key] || !value.trim() || phoneChannels[key].valid(value));
  });
}

// Blank inputs leave the saved profile alone, including fields absent on older rows.
export function orderCustomerChanges(before, input) {
  const changes = {};
  for (const key of customerFields) {
    const value = input[key];
    if (key === 'tags') {
      const stored = before?.tags || [];
      if (Array.isArray(value) && value.length && (value.length !== stored.length || value.some(tag => !stored.includes(tag))))
        changes.tags = [...value];
    } else if (typeof value === 'string' && value.trim() && identityKey(key, value) !== identityKey(key, before?.[key])) {
      changes[key] = phoneChannels[key]?.key(value) ?? value.trim();
    }
  }
  return changes;
}

export function matchInlineOrderCustomer(customers, input) {
  const matches = {};
  const result = (kind, ids = [], customerId) => ({ kind, ids, matches, ...(customerId && { customerId }) });
  if (!validProfileInput(input)) return result('invalid');
  const keys = [...channels, 'name'].filter(key => identityKey(key, input[key]));
  if (!keys.length) return result('empty');

  for (const key of keys) {
    const value = identityKey(key, input[key]);
    const ids = customers.filter(row => identityKey(key, row[key]) === value).map(row => row.id);
    if (ids.length) matches[key] = ids;
  }
  const groups = Object.values(matches);
  if (!groups.length) return result('new');

  // A shared family number may belong to several profiles. Only a profile present
  // in every matching field can explain the inputs without reassigning a contact.
  const [first, ...others] = groups;
  const candidateIds = new Set(first);
  for (const ids of others) {
    const fieldIds = new Set(ids);
    for (const id of candidateIds) if (!fieldIds.has(id)) candidateIds.delete(id);
  }
  if (!candidateIds.size) return result('conflict', [...new Set(groups.flat())]);
  const active = customers.filter(row => candidateIds.has(row.id) && row.active !== false);
  const available = active.map(row => row.id);
  if (!available.length) return result('inactive', [...candidateIds]);
  if (candidateIds.size > 1 || !channels.some(key => matches[key])) return result('review', available);

  const [customer] = active;
  const changes = orderCustomerChanges(customer, input);
  // A new tag or a previously empty field does not introduce a second identity.
  // The actual update still requires calibration confirmation before saving.
  const replacedIdentity = keys.some(key => Object.hasOwn(changes, key) && identityKey(key, customer[key]));
  if (replacedIdentity) return result('review', available);
  return result('matched', available, customer.id);
}
