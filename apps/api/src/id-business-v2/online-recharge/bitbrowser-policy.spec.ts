import { describe, expect, it } from 'vitest';
import { ONLINE_RECHARGE_DEFAULTS } from './contracts';
import {
  bitbrowserPolicy,
  executionChannel,
  validateBitbrowserQuote,
  validateBitbrowserSettings
} from './bitbrowser-policy';

export const quoteFixture = {
  plan: 'plus',
  today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  renewal_interval: 'monthly'
};
const policy = {
  mode: 'automatic' as const,
  currency: 'USD',
  maxAmount: '20.00',
  proxyCountryCode: 'US',
  deviceId: 'fixture'
};
describe('比特通道策略与核价', () => {
  it('旧配置继续按原第三方开关解析通道，显式通道优先', () => {
    expect(executionChannel({ gptApiEnabled: true })).toBe('third_party');
    expect(executionChannel({})).toBe('local');
    expect(executionChannel({ executionChannel: 'bitbrowser', gptApiEnabled: true })).toBe(
      'bitbrowser'
    );
    expect(() => executionChannel({ executionChannel: 'unknown' })).toThrow();
  });
  it('默认人工付款，全自动必须配置完整金额上限', () => {
    expect(() => validateBitbrowserSettings({ ...ONLINE_RECHARGE_DEFAULTS })).not.toThrow();
    expect(() =>
      validateBitbrowserSettings({
        ...ONLINE_RECHARGE_DEFAULTS,
        bitBrowserPaymentMode: 'automatic'
      })
    ).toThrow('上限');
    expect(() =>
      validateBitbrowserSettings({
        ...ONLINE_RECHARGE_DEFAULTS,
        bitBrowserPaymentMode: 'automatic',
        bitBrowserPlusMaxAmount: '20',
        bitBrowserPro5xMaxAmount: '100000',
        bitBrowserPro20xMaxAmount: '200'
      })
    ).not.toThrow();
  });
  it('本机接口不接受公网、用户信息、路径或重定向地址', () => {
    for (const value of [
      'https://example.invalid',
      'http://example.invalid:54345',
      'http://127.0.0.1:54345/path',
      'http://user:key@127.0.0.1:54345',
      'invalid'
    ])
      expect(() =>
        validateBitbrowserSettings({ ...ONLINE_RECHARGE_DEFAULTS, bitBrowserApiUrl: value })
      ).toThrow();
  });
  it('Pro 5 倍固定智利和 CLP，其他套餐保留提交时配置', () => {
    const settings = { ...ONLINE_RECHARGE_DEFAULTS, proxyCountryCode: 'PH' };
    expect(bitbrowserPolicy(settings, 'pro_5x', 'device')).toMatchObject({
      currency: 'CLP',
      proxyCountryCode: 'CL',
      mode: 'manual'
    });
    expect(bitbrowserPolicy(settings, 'plus', 'device')).toMatchObject({
      currency: 'PHP',
      proxyCountryCode: 'PH'
    });
  });
  it('首版比特通道拒绝未验收的 Pro 500 套餐', () => {
    expect(() => bitbrowserPolicy(ONLINE_RECHARGE_DEFAULTS, 'pro_500', 'device')).toThrow();
  });
  it('使用 Decimal 判断金额上限，等于上限自动通过，超限转人工核对', () => {
    expect(validateBitbrowserQuote(quoteFixture, 'plus', policy).digest).toBe(
      'eaff785ed606d76d29bcb3d34a640ac015ff03cf0ed84095d711f9b90f89c56d'
    );
    expect(validateBitbrowserQuote(quoteFixture, 'plus', policy).automatic).toBe(true);
    expect(
      validateBitbrowserQuote(quoteFixture, 'plus', { ...policy, maxAmount: '19.9999' }).automatic
    ).toBe(false);
    expect(
      validateBitbrowserQuote(quoteFixture, 'plus', { ...policy, mode: 'manual' }).automatic
    ).toBe(false);
  });
  it('币种、套餐、单位、正负金额和续费周期不匹配均拒绝', () => {
    for (const value of [
      { ...quoteFixture, plan: 'pro-20x' },
      { ...quoteFixture, renewal_interval: 'yearly' },
      { ...quoteFixture, today: { ...quoteFixture.today, amount: '20.001' } },
      { ...quoteFixture, today: { ...quoteFixture.today, amount_minor: 1999 } },
      { ...quoteFixture, tax: { ...quoteFixture.tax, amount: '-1' } },
      { ...quoteFixture, today: { ...quoteFixture.today, currency: 'PHP' } }
    ])
      expect(() => validateBitbrowserQuote(value, 'plus', policy)).toThrow();
  });
});
