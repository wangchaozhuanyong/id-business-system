import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src/id-business-v2');

function read(relativePath: string) {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
}

describe('permanently reported account loss guards', () => {
  it('blocks account editing, balance adjustment and deletion', () => {
    const source = read('accounts/id-business-v2-accounts.service.ts');

    expect(source).toContain('已报损 ID 永久冻结，不能再修改');
    expect(source).toContain('已报损 ID 永久冻结，不能调整余额');
    expect(source).toContain('已报损 ID 必须保留历史记录，不能删除');
    expect(source).toMatch(/updateMany\(\{\s*where: \{ id: existing\.id, lossReportedAt: null \}/s);
  });

  it('excludes loss-reported IDs from top-up, matching, locking and deduction paths', () => {
    const topupList = read('balances/id-business-v2-topup-workbench.service.ts');
    const giftCardCredit = read('gift-cards/id-business-v2-gift-card-credit.service.ts');
    const giftCardReversal = read('gift-cards/id-business-v2-gift-card-reversal.service.ts');
    const matching = read('orders/id-business-v2-order-matching.service.ts');
    const locking = read('orders/id-business-v2-order-lock.service.ts');
    const consumption = read('orders/id-business-v2-order-consumption.service.ts');

    expect(topupList).toMatch(/lossReportedAt:\s*null/);
    expect(giftCardCredit).toContain('"loss_reported_at" IS NULL');
    expect(giftCardCredit).toContain('已报损 ID 永久冻结，不能继续加卡');
    expect(giftCardReversal).toContain('if (account.lossReportedAt)');
    expect(giftCardReversal.indexOf('if (existingEntry?.giftCard)')).toBeLessThan(
      giftCardReversal.indexOf('if (account.lossReportedAt)')
    );
    expect(matching).toMatch(/lossReportedAt:\s*null/);
    expect(locking).toContain('account."loss_reported_at" IS NULL');
    expect(consumption).toContain('prepareOrderConsumptionInTransaction');
  });

  it('blocks manual renewal, refund restore and sold-account recovery', () => {
    const manualRenewal = read('renewals/id-business-v2-manual-renewal.service.ts');
    const lifecycle = read('orders/id-business-v2-order-lifecycle-support.ts');
    const accountDisposition = read('orders/id-business-v2-order-account-disposition.ts');

    expect(manualRenewal).toContain('"loss_reported_at" IS NULL');
    expect(manualRenewal).toContain('已报损 ID 永久冻结，不能续费');
    expect(lifecycle).toContain('已报损 ID 永久冻结，不能恢复余额');
    expect(accountDisposition).toContain('lossReportedAt: null');
    expect(accountDisposition).toContain('已报损 ID 永久冻结，不能标记为收回或恢复可用');
  });
});
