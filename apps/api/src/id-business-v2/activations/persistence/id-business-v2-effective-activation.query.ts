import type { Prisma } from '@prisma/client';

/**
 * 生效中的升级退币已经结束原开通。此条件同时兼容修复发布前
 * 未能物理更新开通状态的历史记录，不修改原始流水。
 */
export function buildIdBusinessV2EffectiveActivationWhere(): Prisma.IdBusinessV2ActivationWhereInput {
  return {
    order: {
      is: {
        balanceReturns: { none: { status: 'active' } }
      }
    }
  };
}

export const ID_BUSINESS_V2_ACTIVE_BALANCE_RETURN_SELECT = {
  where: { status: 'active' as const },
  select: { id: true },
  take: 1
};
