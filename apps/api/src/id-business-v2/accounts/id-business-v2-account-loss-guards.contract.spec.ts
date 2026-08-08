import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src/id-business-v2');

function read(relativePath: string) {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
}

describe('reported account loss freeze guards', () => {
  it('blocks account editing and balance adjustment, and removes the account delete API', () => {
    const source = read('accounts/id-business-v2-accounts.service.ts');
    const controller = read('accounts/id-business-v2-accounts.controller.ts');
    const balanceAdjustment = read('accounts/id-business-v2-account-balance-adjustment.service.ts');
    const repository = read('accounts/persistence/id-business-v2-accounts.repository.ts');

    expect(source).toContain('已报损冻结 ID 不能再修改');
    expect(balanceAdjustment).toContain('已报损冻结 ID 不能调整余额');
    expect(controller).not.toContain("@Delete(':id')");
    expect(repository).not.toContain('softDelete(');
    expect(repository).toContain('lossReportedAt: null');
  });

  it('excludes loss-reported IDs from top-up, matching, locking and deduction paths', () => {
    const topupRepository = read('balances/persistence/id-business-v2-balance-query.repository.ts');
    const giftCardCredit = read('gift-cards/id-business-v2-gift-card-credit.service.ts');
    const giftCardRepository = read(
      'gift-cards/persistence/id-business-v2-gift-cards.repository.ts'
    );
    const giftCardReversal = read('gift-cards/id-business-v2-gift-card-reversal.service.ts');
    const locking = read('orders/id-business-v2-order-lock.service.ts');
    const orderRepository = read('orders/persistence/id-business-v2-orders.repository.ts');
    const consumption = read('orders/id-business-v2-order-consumption.service.ts');

    expect(topupRepository).toMatch(/lossReportedAt:\s*null/);
    expect(giftCardRepository).toContain('account."loss_reported_at" IS NULL');
    expect(giftCardCredit).toContain('已报损冻结 ID 不能继续加卡');
    expect(giftCardReversal).toContain('if (account.lossReportedAt)');
    expect(giftCardReversal.indexOf('if (existingEntry?.giftCard)')).toBeLessThan(
      giftCardReversal.indexOf('if (account.lossReportedAt)')
    );
    expect(orderRepository).toMatch(/lossReportedAt:\s*null/);
    expect(orderRepository).toContain('account."loss_reported_at" IS NULL');
    expect(locking).toContain('已报损冻结 ID 不能锁定或扣减余额');
    expect(consumption).toContain('prepareOrderConsumptionInTransaction');
  });

  it('blocks manual renewal, refund restore and sold-account recovery', () => {
    const manualRenewal = read('renewals/id-business-v2-manual-renewal.service.ts');
    const renewalRepository = read('renewals/persistence/id-business-v2-renewals.repository.ts');
    const lifecycle = read('orders/id-business-v2-order-lifecycle-support.ts');
    const accountDisposition = read('orders/id-business-v2-order-account-disposition.ts');
    const orderRepository = read('orders/persistence/id-business-v2-orders.repository.ts');

    expect(renewalRepository).toContain('"loss_reported_at" IS NULL');
    expect(manualRenewal).toContain('已报损冻结 ID 不能续费');
    expect(lifecycle).toContain('已报损冻结 ID 不能恢复余额');
    expect(orderRepository).toMatch(/releaseSoldAccount[\s\S]*lossReportedAt:\s*null/);
    expect(accountDisposition).toContain('已报损冻结 ID 不能标记为收回或恢复可用');
  });
});
