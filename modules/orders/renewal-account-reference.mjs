export const renewalAccountReferenceMaxLength = 2048;

const identityFields = new Set(['id', 'userId', 'user_id', 'accountId', 'account_id', 'platformAccountId', 'platform_account_id']);
const privateValuePrefix = /^(?:sk[-_]|gh[pousr]_|github_pat_|xox[a-z]-|ya29[-_.]|eyJ|gsk_|hf_|xai-|pplx-|AIza|AKIA|ASIA|bearer[-_]|(?:session|token|password|secret)[-_])/i;
const email = /^[a-z0-9][a-z0-9._+%-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/i;
const username = /^@?[a-z0-9_]{1,30}$/i;
const identity = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const invalidReference = () => new Error('账号 JSON / ID 仅支持账号标识、邮箱和用户名。请移除登录凭证及其他字段。');

function accountId(value) {
  return identity.test(value) && !privateValuePrefix.test(value) && !/^\d{12,19}$/.test(value) &&
    (value.length <= 32 || /^(?:user[-_]|acct[-_]|account[-_])[a-z0-9_-]+$/i.test(value) ||
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function accountUsername(value) {
  const name = value.replace(/^@/, '');
  return username.test(value) && !privateValuePrefix.test(name) && !/^\d{12,19}$/.test(name);
}

function validateObject(value, nested = false) {
  if (!plainObject(value) || !Object.keys(value).length) throw invalidReference();
  return Object.fromEntries(Object.entries(value).map(([field, input]) => {
    if (!nested && (field === 'user' || field === 'account')) return [field, validateObject(input, true)];
    const normalized = typeof input === 'string' ? input.trim()
      : identityFields.has(field) && Number.isSafeInteger(input) && input > 0 ? String(input) : '';
    const property = identityFields.has(field) ? accountId(normalized)
      : field === 'email' ? email.test(normalized)
        : (field === 'username' || field === 'xHandle') && accountUsername(normalized);
    if (!property) throw invalidReference();
    return [field, normalized];
  }));
}

export function validateRenewalAccountReference(input) {
  if (typeof input !== 'string' || input.length > renewalAccountReferenceMaxLength) throw invalidReference();
  const value = input.trim();
  if (!value) return '';
  if (value.startsWith('{')) {
    try {
      const normalized = JSON.stringify(validateObject(JSON.parse(value)));
      if (normalized.length <= renewalAccountReferenceMaxLength) return normalized;
    } catch {}
    throw invalidReference();
  }
  if (accountId(value) || email.test(value) || (value.startsWith('@') && accountUsername(value))) return value;
  throw invalidReference();
}
