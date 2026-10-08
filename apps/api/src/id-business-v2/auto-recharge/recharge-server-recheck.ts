import { ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';

/** 原付款记录保留，复查必须在所属比特窗口只读执行。 */
export async function startServerRecheck(
  value: unknown,
  operator: AuthenticatedUser,
  deps: unknown
): Promise<{ id: string }> {
  void value;
  void operator;
  void deps;
  throw new ConflictException('服务器充值复查已停用，请使用比特浏览器只读复查原订单');
}
