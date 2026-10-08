import { ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';

/** 保留旧 API 的明确失败回执，禁止再向服务器浏览器派发充值。 */
export async function startRechargeJob(
  value: unknown,
  operator: AuthenticatedUser,
  deps: unknown
): Promise<{ id: string }> {
  void value;
  void operator;
  void deps;
  throw new ConflictException('服务器充值已停用，请使用比特浏览器充值');
}
