import { describe, expect, it } from 'vitest';
import pageSource from './useTopupWorkbenchPage.ts?raw';

describe('topup confirmation UI contract', () => {
  it('shows the complete normalized gift card code in the credit confirmation dialog', () => {
    expect(pageSource).toContain('} ${normalizedCreditCode.value}，国家为 ${');
    expect(pageSource).not.toContain('maskGiftCardCode(normalizedCreditCode.value)');
  });
});
