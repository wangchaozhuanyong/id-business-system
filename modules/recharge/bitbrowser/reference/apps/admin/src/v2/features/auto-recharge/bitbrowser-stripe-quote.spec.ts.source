import { describe, expect, it } from 'vitest';
import type { V2RechargeDetails, V2RechargePlan } from './contracts';
import {
  directCheckoutPlanMatches,
  stripeQuoteCheckout,
  stripeQuoteDocument,
  verifyDirectCheckoutQuote
} from './bitbrowser-stripe-quote';

const id = 'cs_live_SYNTHETIC';
const details: V2RechargeDetails = {
  number: '4242424242424242',
  expiry: '12/39',
  cvc: '123',
  name: 'Synthetic Buyer',
  email: 'buyer@example.invalid',
  country: 'US',
  line1: '123 Test Street',
  line2: '',
  city: 'Test City',
  state: 'CA',
  postal_code: '90001'
};
const text = 'Total due today PHP 5794.64\nTax PHP 0.00\nRenews PHP 5794.64 / month';
const meta = () => ({
  checkout_session_id: id,
  processor_entity: 'openai_llc',
  plan_name: 'chatgptprolite',
  status: 'open',
  payment_status: 'unpaid'
});
function rawQuote() {
  return {
    id: 'ppage_SYNTHETIC',
    session_id: id,
    object: 'checkout.session',
    mode: 'subscription',
    currency: 'php',
    client_secret: 'SYNTHETIC_DO_NOT_RETAIN',
    total_summary: { due: 579464, total: 579464, total_tax_amounts: [{ amount: 0 }] },
    recurring_details: { total_summary: { total: 579464 } },
    invoice: {
      amount_due: 579464,
      total: 579464,
      currency: 'php',
      lines: { has_more: false, data: [{ quantity: 1, price: { currency: 'php' } }] }
    },
    customer: {
      name: details.name,
      email: details.email,
      address: {
        country: 'US',
        line1: details.line1,
        line2: '',
        city: details.city,
        state: 'CA',
        postal_code: '90001'
      }
    }
  };
}
const snapshot = () => stripeQuoteDocument(rawQuote(), id)!;
const verify = (
  stripe = snapshot(),
  metadata = meta(),
  quoteText = text,
  tierVerified = true,
  plan: V2RechargePlan = 'pro-5x'
) =>
  verifyDirectCheckoutQuote(
    metadata,
    id,
    'openai_llc',
    plan,
    details,
    quoteText,
    'PHP',
    stripe,
    tierVerified,
    true
  );

describe('Stripe 原单、最新计税明细与完整账单绑定', () => {
  it('原 Pro CS 可恢复共用初始套餐，其他处理器和跨套餐原单不放宽', () => {
    expect(directCheckoutPlanMatches('pro-20x', 'chatgptprolite', id)).toBe(true);
    expect(directCheckoutPlanMatches('pro-500', 'chatgptprolite', id)).toBe(true);
    expect(directCheckoutPlanMatches('pro-500', 'chatgptprolite', 'oaics_synthetic')).toBe(false);
    expect(directCheckoutPlanMatches('plus', 'chatgptprolite', id)).toBe(false);
    expect(directCheckoutPlanMatches('pro-20x', 'chatgptplusplan', id)).toBe(false);
  });
  it('接受实测 ppage ID，通过请求绑定的 session_id 核实 CS，不留完整响应', async () => {
    const stripe = rawQuote();
    stripe.customer.name = 'Account Customer Name';
    const result = await verify(stripeQuoteDocument(stripe, id)!);
    expect(result.quote.today?.amount_minor).toBe(579464);
    expect(result.quote.tax?.amount_minor).toBe(0);
    expect(result.billing_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot())).not.toMatch(
      /SYNTHETIC_DO_NOT_RETAIN|client_secret|buyer@example/
    );
    expect(JSON.stringify(result)).not.toContain(details.number);
  });
  it.each(['pro-5x', 'pro-20x', 'pro-500'] as const)(
    'Pro 共用初始建单套餐仅在当前 %s 档位再次核实时允许核价',
    async (plan) => {
      await expect(verify(snapshot(), meta(), text, true, plan)).resolves.toBeDefined();
      await expect(verify(snapshot(), meta(), text, false, plan)).rejects.toThrow(
        'official_pro_tier_unverified'
      );
    }
  );
  it.each(['object', 'session_id', 'mode'] as const)('拒绝不属于当前原单的 %s', (key) => {
    const raw = rawQuote();
    raw[key] = 'other';
    expect(stripeQuoteDocument(raw, id)).toBeUndefined();
  });
  it.each([
    ['checkoutId', 'cs_other'],
    ['currency', 'usd'],
    ['invoiceCurrency', 'usd'],
    ['priceCurrency', 'usd'],
    ['due', 649000],
    ['due', -1],
    ['due', 1.5],
    ['due', '579464'],
    ['renewal', 649000],
    ['invoiceDue', 649000],
    ['invoiceTotal', 649000],
    ['taxes', undefined],
    ['taxes', [-1]],
    ['taxes', [69536]],
    ['taxes', [0.1]],
    ['itemCount', 2],
    ['hasMore', true],
    ['quantity', 2],
    ['interval', 'year'],
    ['intervalCount', 12]
  ])('冲突或不完整 %s 不能通过', async (key, value) => {
    await expect(verify({ ...snapshot(), [String(key)]: value })).rejects.toThrow();
  });
  it.each([
    'checkout_session_id',
    'processor_entity',
    'plan_name',
    'status',
    'payment_status'
  ] as const)('官网当前元数据 %s 必须一致', async (key) => {
    const metadata = meta();
    metadata[key] = 'other';
    await expect(verify(snapshot(), metadata)).rejects.toThrow('checkout_response_plan_unverified');
  });
  it.each(['country', 'state', 'city', 'line1', 'line2', 'postal_code'])(
    '拒绝计税地址 %s 与填写资料不同',
    async (key) => {
      const stripe = snapshot();
      stripe.billing[key] = 'other';
      await expect(verify(stripe)).rejects.toThrow(`official_billing_${key}_mismatch`);
    }
  );
  it('未收到最新计税明细、未核实实时表单或月度续费缺失均不放行', async () => {
    await expect(
      verifyDirectCheckoutQuote(
        meta(),
        id,
        'openai_llc',
        'pro-5x',
        details,
        text,
        'PHP',
        undefined,
        true
      )
    ).rejects.toThrow('official_checkout_quote_unavailable');
    await expect(
      verifyDirectCheckoutQuote(
        meta(),
        id,
        'openai_llc',
        'pro-5x',
        details,
        text,
        'PHP',
        snapshot(),
        true,
        false
      )
    ).rejects.toThrow('billing_fields_incomplete');
    await expect(verify(snapshot(), meta(), text.replace('/ month', '/ year'))).rejects.toThrow();
  });
  it('非零税额和月续费分别对照，不以旧的免税报价通过', async () => {
    const stripe = {
      ...snapshot(),
      due: 649000,
      total: 649000,
      invoiceDue: 649000,
      invoiceTotal: 649000,
      taxes: [69536],
      renewal: 649000
    };
    const taxed = 'Total due today PHP 6490.00\nTax PHP 695.36\nRenews PHP 6490.00 / month';
    await expect(verify(stripe, meta(), taxed)).resolves.toBeDefined();
    await expect(verify(stripe)).rejects.toThrow();
  });
  it('只接受 Stripe 精确原单读取、初始化和更新路径', () => {
    for (const suffix of ['', '/init', '/update'])
      expect(stripeQuoteCheckout(`/v1/payment_pages/${id}${suffix}`)).toBe(id);
    for (const suffix of ['/confirm', '/other', '/update/extra'])
      expect(stripeQuoteCheckout(`/v1/payment_pages/${id}${suffix}`)).toBeUndefined();
  });
});
