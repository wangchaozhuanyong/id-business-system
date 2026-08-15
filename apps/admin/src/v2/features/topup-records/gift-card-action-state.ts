import type { V2GiftCardRecord } from './contracts';

interface GiftCardActionPermissions {
  canAdjustBalance: boolean;
  canReassignSupplier: boolean;
}

export interface GiftCardActionState {
  canOpenFinancialActions: boolean;
  canReassignSupplier: boolean;
  blockedReason: string;
  blockedDescription: string;
  blockedTagType: 'danger' | 'info';
}

export function getGiftCardActionState(
  giftCard: Pick<V2GiftCardRecord, 'account'>,
  permissions: GiftCardActionPermissions
): GiftCardActionState {
  const accountFrozen = giftCard.account.lossStatus === 'reported';
  const canOpenFinancialActions = permissions.canAdjustBalance && !accountFrozen;
  const canReassignSupplier = permissions.canReassignSupplier;

  if (accountFrozen) {
    return {
      canOpenFinancialActions,
      canReassignSupplier,
      blockedReason: 'ID 已报损冻结',
      blockedDescription: '已报损冻结 ID 不能修改备注或处理余额',
      blockedTagType: 'danger'
    };
  }

  if (!canOpenFinancialActions && !canReassignSupplier) {
    return {
      canOpenFinancialActions,
      canReassignSupplier,
      blockedReason: '无操作权限',
      blockedDescription: '当前账号没有余额调整或供应商资金管理权限',
      blockedTagType: 'info'
    };
  }

  return {
    canOpenFinancialActions,
    canReassignSupplier,
    blockedReason: '',
    blockedDescription: '',
    blockedTagType: 'info'
  };
}
