import { describe, expect, it } from 'vitest';
import dialogs from './components/V2TopupWorkbenchDialogs.vue?raw';

const creditDrawer = dialogs.slice(dialogs.indexOf('<V2FormDrawer'), dialogs.indexOf('<el-drawer'));

describe('gift card credit dialog UI contract', () => {
  it('uses a compact account overview and two-column task layout', () => {
    expect(creditDrawer).toContain('size="min(960px, 96vw)"');
    expect(creditDrawer).toContain('v2-topup-credit-entry-target--credit');
    expect(creditDrawer).toContain('v2-topup-credit-layout');
    expect(creditDrawer).toContain('v2-topup-credit-card-panel');
    expect(creditDrawer).toContain('v2-topup-credit-settlement-panel');
    expect(creditDrawer).toContain('卡片资料');
    expect(creditDrawer).toContain('结算与备注');
  });

  it('keeps every business input while removing duplicate calculation blocks', () => {
    for (const prop of [
      'cardNameOptionId',
      'countryOptionId',
      'code',
      'faceValue',
      'exchangeRate',
      'supplierOptionId',
      'creditedAt'
    ]) {
      expect(creditDrawer).toContain(`prop="${prop}"`);
    }
    expect(creditDrawer).toContain('v-model="page.creditForm.remark"');
    expect(creditDrawer).toContain('aria-label="礼品卡结算预览"');
    expect(creditDrawer).toContain('aria-live="polite"');
    expect(creditDrawer).toContain('aria-label="国家（跟随目标 ID）"');
    expect(creditDrawer).toContain('readonly');
    expect(creditDrawer).not.toContain('v2-topup-credit-summary');
    expect(creditDrawer).not.toContain('卡片价值按“礼品卡面值 × 卡片汇率”计算');
  });

  it('requires explicit confirmation before opening credit entry for a sold ID', () => {
    expect(dialogs).toContain('title="确认给已售出 ID 加卡"');
    expect(dialogs).toContain('confirm-text="确认，为已售 ID 加卡"');
    expect(dialogs).toContain('page.soldCreditPromptAccount.soldByOrder.orderNo');
    expect(dialogs).toContain('page.soldCreditPromptAccount.soldByOrder.customer.name');
    expect(dialogs).toContain('@confirm="page.confirmSoldCreditPrompt"');
  });
});
