import { describe, expect, it } from 'vitest';
import type { V2GiftCardRecord } from './contracts';
import { getGiftCardActionState } from './gift-card-action-state';

function makeGiftCard(lossStatus: 'active' | 'reported') {
  return {
    account: {
      lossStatus
    }
  } as Pick<V2GiftCardRecord, 'account'>;
}

describe('gift card action state', () => {
  it('keeps supplier correction available while explaining frozen balance actions', () => {
    expect(
      getGiftCardActionState(makeGiftCard('reported'), {
        canAdjustBalance: true,
        canReassignSupplier: true
      })
    ).toEqual({
      canOpenFinancialActions: false,
      canReassignSupplier: true,
      blockedReason: 'ID 已报损冻结',
      blockedDescription: '已报损冻结 ID 不能修改备注或处理余额',
      blockedTagType: 'danger'
    });
  });

  it('marks rows without any available operation as permission blocked', () => {
    expect(
      getGiftCardActionState(makeGiftCard('active'), {
        canAdjustBalance: false,
        canReassignSupplier: false
      })
    ).toMatchObject({
      canOpenFinancialActions: false,
      canReassignSupplier: false,
      blockedReason: '无操作权限'
    });
  });

  it('enables both action groups for an active ID with both permissions', () => {
    expect(
      getGiftCardActionState(makeGiftCard('active'), {
        canAdjustBalance: true,
        canReassignSupplier: true
      })
    ).toEqual({
      canOpenFinancialActions: true,
      canReassignSupplier: true,
      blockedReason: '',
      blockedDescription: '',
      blockedTagType: 'info'
    });
  });
});
