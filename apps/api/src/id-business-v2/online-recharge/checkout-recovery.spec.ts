import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkoutRecovery } from './checkout-recovery';
import type { OnlineRechargePaymentContext } from './contracts';

function fixture(checkoutId = 'oaics_fixture_original') {
  const context: OnlineRechargePaymentContext = {
    kind: 'initial',
    sourcePlan: 'free',
    targetPlan: 'pro_20x',
    accountId: 'fixture-account',
    cardId: 'fixture-card',
    cardLast4: '4242',
    currency: 'PHP',
    amount: '9990.00',
    quoteId: `quote:${createHash('sha256').update(checkoutId).digest('hex').slice(0, 32)}`
  };
  const recovery = {
    ...context,
    version: 1,
    checkoutId,
    processorEntity: checkoutId.startsWith('oaics_') ? 'openai' : null,
    checkoutUrl: checkoutId.startsWith('oaics_')
      ? `https://chatgpt.com/checkout/openai/${checkoutId}`
      : `https://checkout.stripe.com/c/pay/${checkoutId}#synthetic`
  };
  return { context, recovery };
}
describe('原单恢复身份约束', () => {
  it('兼容明确官方原生与托管原单，金额按 Decimal 相等而非浮点数判断', () => {
    for (const checkoutId of ['oaics_fixture_original', 'cs_live_fixtureOriginal']) {
      const { context, recovery } = fixture(checkoutId);
      expect(checkoutRecovery({ ...recovery, amount: '9990' }, context)).toEqual({
        ...recovery,
        amount: '9990.00'
      });
    }
  });
  it.each([
    { version: 0 },
    { checkoutId: 'oaics_other' },
    { quoteId: 'quote:invented' },
    { amount: '9990.01' },
    { accountId: 'other' },
    { cardId: 'other' },
    { cardLast4: '9999' },
    { currency: 'USD' },
    { targetPlan: 'plus' },
    { sourcePlan: 'plus' },
    { kind: 'upgrade' },
    { processorEntity: 'stripe' },
    { checkoutUrl: 'https://chatgpt.com.evil.test/checkout/openai/oaics_fixture_original' },
    { checkoutUrl: 'http://chatgpt.com/checkout/openai/oaics_fixture_original' },
    { checkoutUrl: 'https://user:password@chatgpt.com/checkout/openai/oaics_fixture_original' },
    { checkoutUrl: 'https://chatgpt.com/checkout/openai/oaics_fixture_original/other' },
    { checkoutUrl: 'https://chatgpt.com:9443/checkout/openai/oaics_fixture_original' }
  ])('拒绝错绑或非官方恢复资料 %j', (change) => {
    const { context, recovery } = fixture();
    expect(() => checkoutRecovery({ ...recovery, ...change }, context)).toThrow();
  });
  it('报价编号必须确实来自原 checkoutId，不能同时伪造两个相等的 quoteId', () => {
    const { context, recovery } = fixture();
    expect(() =>
      checkoutRecovery(
        { ...recovery, quoteId: 'quote:invented' },
        { ...context, quoteId: 'quote:invented' }
      )
    ).toThrow();
  });
});
