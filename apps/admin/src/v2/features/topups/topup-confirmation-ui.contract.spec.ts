import { describe, expect, it } from 'vitest';
import dialogs from './components/V2TopupWorkbenchDialogs.vue?raw';

describe('topup confirmation UI contract', () => {
  it('shows the complete normalized gift card code in the credit confirmation dialog', () => {
    expect(dialogs).toContain("page.normalizedCreditCode || page.creditForm.code || '—'");
    expect(dialogs).not.toContain('maskGiftCardCode(page.normalizedCreditCode)');
  });
});
