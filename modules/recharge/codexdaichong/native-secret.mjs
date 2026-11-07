import { createHmac } from 'node:crypto';

const nativeSecretDomain = 'id-business/codexdaichong/native-admin-token/f4d7761/v1';

/** Resolve in memory only; both the pristine process and its adapter use this boundary. */
export function resolveNativeAdminTokenSecret(env = process.env) {
  const configured = env.ADMIN_TOKEN_SECRET;
  if (configured !== undefined && typeof configured !== 'string')
    throw new TypeError('原版签名配置格式无效');
  const existing = configured?.trim() ?? '';
  if (existing) {
    if (existing.length < 32) throw new TypeError('已有原版签名配置长度不足');
    return existing;
  }
  const bridge = env.ID_RECHARGE_BRIDGE_SECRET;
  if (typeof bridge !== 'string' || Buffer.byteLength(bridge) < 32)
    throw new TypeError('原版签名派生需要有效的既有桥接配置');
  return createHmac('sha256', bridge).update(nativeSecretDomain).digest('base64url');
}
