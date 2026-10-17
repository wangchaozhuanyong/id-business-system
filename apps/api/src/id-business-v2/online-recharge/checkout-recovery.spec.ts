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
function embeddedFixture(processorEntity = 'openai_llc') {
  const { context, recovery } = fixture('cs_live_fixtureOriginal');
  return {
    context,
    recovery: {
      ...recovery,
      processorEntity,
      checkoutUrl: `https://chatgpt.com/checkout/${processorEntity}/${recovery.checkoutId}`,
      source: {
        kind: 'official_checkout_response' as const,
        checkoutId: recovery.checkoutId,
        processorEntity
      }
    }
  };
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
  it.each(['openai_llc', 'openai_ireland'])(
    '使用官网响应的处理实体 %s 支持 ChatGPT 内嵌 Stripe 原单，不猜测实体',
    (processorEntity) => {
      const { context, recovery } = embeddedFixture(processorEntity);
      expect(checkoutRecovery({ ...recovery, amount: '9990' }, context)).toEqual(recovery);
    }
  );
  it('内嵌 cs 原单没有来源投影时不得退回仅凭 URL 放行', () => {
    const { context, recovery } = embeddedFixture();
    const withoutSource: Partial<typeof recovery> = { ...recovery };
    delete withoutSource.source;
    expect(() => checkoutRecovery(withoutSource, context)).toThrow();
  });
  it.each([
    null,
    [],
    'official_checkout_response',
    {},
    { kind: 'guessed_url', checkoutId: 'cs_live_fixtureOriginal', processorEntity: 'openai_llc' },
    {
      kind: 'official_checkout_response',
      checkoutId: 'cs_live_anotherOriginal',
      processorEntity: 'openai_llc'
    },
    {
      kind: 'official_checkout_response',
      checkoutId: 'cs_live_fixtureOriginal',
      processorEntity: 'openai_ireland'
    },
    {
      kind: 'official_checkout_response',
      checkoutId: 'cs_live_fixtureOriginal',
      processorEntity: 'openai_llc',
      accessToken: 'synthetic-extra-field'
    }
  ])('拒绝缺失、猜测、错单或非受控的原响应投影 %j', (source) => {
    const { context, recovery } = embeddedFixture();
    expect(() => checkoutRecovery({ ...recovery, source }, context)).toThrow();
  });
  it.each([
    { processorEntity: null },
    { processorEntity: 'OpenAI_LLC' },
    { processorEntity: '../openai_llc' },
    { checkoutUrl: 'https://chatgpt.com/checkout/openai_ireland/cs_live_fixtureOriginal' },
    { checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live_anotherOriginal' },
    { checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live_fixtureOriginal/confirm' },
    { checkoutUrl: 'https://chatgpt.com.evil.invalid/checkout/openai_llc/cs_live_fixtureOriginal' },
    { checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live_fixtureOriginal%2fother' },
    { amount: '9990.0001' },
    { accountId: 'another-account' },
    { cardId: 'another-card' },
    { currency: 'USD' },
    { targetPlan: 'plus' }
  ])('来源投影不得绕过既有网址及付款绑定校验 %j', (change) => {
    const { context, recovery } = embeddedFixture();
    expect(() => checkoutRecovery({ ...recovery, ...change }, context)).toThrow();
  });
  it('托管原单路径含两个会话编号时拒绝，不能只检查其中之一存在', () => {
    const { context, recovery } = fixture('cs_test_fixtureOriginal');
    expect(() =>
      checkoutRecovery(
        {
          ...recovery,
          checkoutUrl:
            'https://checkout.stripe.com/c/pay/cs_test_fixtureOriginal/cs_test_anotherOriginal'
        },
        context
      )
    ).toThrow();
  });
  it('来源投影只标明原单来源，不包含付款成功标记或秘密资料', () => {
    const { context, recovery } = embeddedFixture();
    const result = checkoutRecovery(recovery, context);
    expect(Object.keys(result.source!)).toEqual(['kind', 'checkoutId', 'processorEntity']);
    expect(result).not.toHaveProperty('confirmedPaid');
    expect(result).not.toHaveProperty('paymentEvidence');
  });
});
