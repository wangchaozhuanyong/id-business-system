import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';

export type BankRechargeOrderChannel = 'bitbrowser' | 'online';
export function bankRechargeOrderChannel(value?: unknown): BankRechargeOrderChannel {
  if (value === undefined || value === 'bitbrowser') return 'bitbrowser';
  if (value === 'online') return 'online';
  throw new BadRequestException('订单渠道无效');
}
export function assertBankRechargeChannelAccess(
  channel: unknown,
  operator?: AuthenticatedUser,
  manage = false
) {
  if (channel !== 'online') return;
  const permission = `id_business_v2.online_recharge.${manage ? 'manage' : 'read'}`;
  if (!operator?.roles.includes('admin') || !operator.permissions?.includes(permission)) {
    throw new ForbiddenException(manage ? '缺少线上订单管理权限' : '缺少线上订单读取权限');
  }
}
export function onlineOrderSnapshot(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function bankRechargePaymentAccountKey(order: {
  channel?: string;
  onlineSourceSnapshot?: unknown;
}) {
  const value = onlineOrderSnapshot(order.onlineSourceSnapshot).accountKey;
  return order.channel === 'online' && typeof value === 'string' && value ? value : null;
}
