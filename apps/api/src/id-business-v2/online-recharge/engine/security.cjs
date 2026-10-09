'use strict';

const secrets = new Set();
function rememberSecrets(value, key = '') {
  if (!value) return;
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) rememberSecrets(v, k);
    return;
  }
  if (
    typeof value === 'string' &&
    /session|token|password|secret|key|cvv|cvc|card_number|number|proxy|chat.?id/i.test(key)
  ) {
    if (value.length >= 3) secrets.add(value);
    if (/session/i.test(key)) {
      try {
        rememberSecrets(JSON.parse(value));
      } catch {
        /* Keep the entire invalid raw value in the redaction set. */
      }
    }
  }
}
function redactText(value) {
  let out = String(value ?? '');
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(secret).join('[已隐藏]');
  return out
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[长凭据已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[会话已隐藏]')
    .replace(/(?:\d[ -]?){12,19}/g, '[敏感号码已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/https?:\/\/[^\s]+/gi, (raw) => {
      try {
        const u = new URL(raw);
        return `${u.origin}${u.pathname.includes('checkout') ? '/[结账链接已隐藏]' : u.pathname.replace(/(?:oaics_|cs_)[a-zA-Z0-9_-]+/g, '[会话已隐藏]')}`;
      } catch {
        return '[地址已隐藏]';
      }
    })
    .slice(0, 4096);
}
function sanitize(value, key = '') {
  if (
    /token|password|secret|api.?key|cvv|cvc|card_number|cookie|session_payload|accessToken|refresh_token|chat.?id|topup.?code|cdk/i.test(
      key
    )
  )
    return '[已隐藏]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return typeof value === 'string' ? redactText(value) : value;
}
function clearSensitive(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/session|token|password|secret|key|cvv|cvc|card_number|number|proxy|chat.?id/i.test(key))
      value[key] = null;
    else if (child && typeof child === 'object') clearSensitive(child);
  }
}
function clearSecrets() {
  secrets.clear();
}
function sanitizeResult(value) {
  const result = sanitize(value);
  const restorePublicBillingLink = (original, sanitized) => {
    if (!original || typeof original !== 'object' || !sanitized || typeof sanitized !== 'object')
      return;
    for (const [key, child] of Object.entries(original)) {
      if (
        key === 'billingPageUrl' &&
        [
          'https://chatgpt.com/account/manage',
          'https://chatgpt.com/#settings/Subscription'
        ].includes(child)
      )
        sanitized[key] = child;
      else if (child && typeof child === 'object') restorePublicBillingLink(child, sanitized[key]);
    }
  };
  restorePublicBillingLink(value, result);
  // A debug checkout link travels only through authenticated RPC into encrypted storage.
  // It is never a log field or an unprotected task-result field.
  if (value?.debugOnly === true && typeof value.checkoutUrl === 'string') {
    try {
      const url = new URL(value.checkoutUrl);
      if (
        url.protocol === 'https:' &&
        ['chatgpt.com', 'pay.openai.com', 'checkout.stripe.com'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        value.checkoutUrl.length < 16000
      )
        result.checkoutUrl = value.checkoutUrl;
    } catch {
      /* Invalid links remain in their already sanitized form. */
    }
  }
  return result;
}
function installSafeConsole(onLog) {
  for (const level of ['log', 'warn', 'error', 'info', 'debug'])
    console[level] = (...args) => {
      const text = redactText(
        args.map((v) => (typeof v === 'string' ? v : JSON.stringify(sanitize(v)))).join(' ')
      );
      onLog?.({ level, text, timestamp: new Date().toISOString() });
    };
}
module.exports = {
  rememberSecrets,
  redactText,
  sanitize,
  sanitizeResult,
  clearSensitive,
  clearSecrets,
  installSafeConsole
};
