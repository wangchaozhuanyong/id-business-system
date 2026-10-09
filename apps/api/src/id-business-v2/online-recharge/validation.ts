import { BadRequestException } from '@nestjs/common';
import { ONLINE_RECHARGE_PLANS, type OnlineRechargePlan } from './contracts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('请求格式无效');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, maximum = 255, required = true): string {
  if (typeof value !== 'string' || value.trim().length > maximum || (required && !value.trim())) {
    if (!required && (value === undefined || value === null)) return '';
    throw new BadRequestException(`${label}格式无效`);
  }
  return value.trim();
}
export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < minimum || n > maximum)
    throw new BadRequestException(`${label}必须为${minimum}至${maximum}的整数`);
  return n;
}
export function id(value: unknown): string {
  const result = text(value, '资料编号', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))
    throw new BadRequestException('资料编号格式无效');
  return result;
}
export function plan(value: unknown): OnlineRechargePlan {
  if (!ONLINE_RECHARGE_PLANS.includes(value as OnlineRechargePlan))
    throw new BadRequestException('套餐无效');
  return value as OnlineRechargePlan;
}
export function ids(input: Record<string, unknown>): string[] {
  const values = input.ids ?? [input.id];
  if (!Array.isArray(values) || !values.length || values.length > 500)
    throw new BadRequestException('请选择1至500条资料');
  return [...new Set(values.map(id))];
}
export function session(value: unknown, full = false) {
  const source = typeof value === 'string' ? value.trim() : JSON.stringify(value);
  if (!source || source.length > 256000) throw new BadRequestException('会话内容格式无效');
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(source));
  } catch {
    if (full || !/^eyJ[A-Za-z0-9._-]+$/.test(source))
      throw new BadRequestException('请提供完整会话 JSON');
    parsed = { accessToken: source };
  }
  const accessToken = parsed.accessToken || parsed.access_token;
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 24000)
    throw new BadRequestException('会话缺少有效访问凭据');
  const user =
    parsed.user && typeof parsed.user === 'object' ? (parsed.user as Record<string, unknown>) : {};
  if (full && (!user.id || typeof user.email !== 'string'))
    throw new BadRequestException('公共入口需要包含账号资料的完整会话');
  try {
    const decoded = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString()
    ) as Record<string, unknown>;
    if (typeof decoded.exp === 'number' && decoded.exp * 1000 <= Date.now())
      throw new BadRequestException('会话已过期，请重新获取');
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
  }
  return {
    source: JSON.stringify(parsed),
    identity: sessionAccountId(JSON.stringify(parsed)) || String(user.id ?? accessToken),
    email: typeof user.email === 'string' ? user.email : ''
  };
}
export function sessionAccountId(value: string | null): string {
  if (!value) return '';
  try {
    const parsed = object(JSON.parse(value));
    const token = parsed.accessToken || parsed.access_token;
    if (typeof token !== 'string') return '';
    const parts = token.trim().split('.');
    if (parts.length !== 3) return '';
    const payload = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString()));
    const accountId = object(payload['https://api.openai.com/auth']).chatgpt_account_id;
    return typeof accountId === 'string' ? accountId : '';
  } catch {
    return '';
  }
}
export function sanitize(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/token|session|cvc|cvv|card[_-]?number|password|secret|api.?key|authorization|cookie|Encrypted|checkoutUrl|paymentUrl|publicToken|^(?:pan|number|cardno|card_no)$/i.test(
              key
            )
        )
        .map(([key, item]) => [
          key,
          /email/i.test(key) && typeof item === 'string' ? maskEmail(item) : sanitize(item, key)
        ])
    );
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1000000000000)
    return '（敏感号码已脱敏）';
  if (
    typeof value === 'string' &&
    /^(?:amount|estimatedAmount|balance|totalAmount)$/i.test(field) &&
    /^-?\d+(\.\d{1,4})?$/.test(value)
  )
    return value;
  if (typeof value === 'string') return redact(value);
  return value;
}
export function redact(value: string): string {
  return value
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '（银行卡已脱敏）')
    .replace(
      /https?:\/\/(?:checkout\.stripe\.com|pay\.openai\.com|chatgpt\.com\/checkout)[^\s"']*/gi,
      '（支付链接已脱敏）'
    )
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '（凭据已脱敏）')
    .replace(
      /((?:\w*token|authorization|cookie|session|cvc|cvv|api[_ -]?key|password|secret)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
      '$1（已脱敏）'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer （已脱敏）')
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/g, '（凭据已脱敏）')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (value) => maskEmail(value))
    .replace(/([a-z]+:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1（已脱敏）@');
}
export function maskEmail(value: string | null): string {
  return value ? value.replace(/^(.).+(@.*)$/, '$1***$2') : '';
}
export const activeTaskStatuses = [
  'queued',
  'running',
  'awaiting_credentials',
  'awaiting_review'
] as const;
