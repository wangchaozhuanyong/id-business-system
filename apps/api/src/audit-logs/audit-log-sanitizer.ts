import type { Prisma } from '@prisma/client';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'passwordencrypted',
  'encryptedpassword',
  'securityinfo',
  'securityinfoencrypted',
  'securityanswers',
  'securityanswer',
  'securityanswersencrypted',
  'phone',
  'phonenumber',
  'phoneencrypted',
  'cardnumber',
  'giftcardnumber',
  'totpsecret',
  'totpsecretencrypted',
  'mfasecret',
  'mfasecretencrypted',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'secret',
  'secretencrypted',
  'encryptedsecret',
  'recoverycode',
  'recoverycodes',
  'recoverycodesencrypted',
  'credentials',
  'logincredentials',
  'apikey',
  'apisecret',
  'privatekey',
  'querycode',
  'querycodeencrypted',
  'cvv',
  'cvc'
]);

// 普通日志和事务日志共用保护规则；日期和金额字符串保留原始语义。
export function sanitizeAuditJsonValue(value: unknown): Prisma.JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeAuditJsonValue);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
          ? '[REDACTED]'
          : sanitizeAuditJsonValue(item)
      ])
    );
  return String(value);
}
