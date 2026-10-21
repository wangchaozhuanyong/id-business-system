import { describe, expect, it } from 'vitest';
import type { V2RechargeDetails } from './contracts';
import { paymentObject, verifyNativeDirectQuote } from './bitbrowser-payment-evidence';
import {
  nativeBillingDetails,
  nativeBillingRequest,
  nativeQuoteDocument,
  type NativeQuoteBinding
} from './bitbrowser-native-quote';

const binding: NativeQuoteBinding = {
  checkoutId: 'oaics_native_quote_fixture',
  entity: 'openai_llc',
  plan: 'plus',
  lockedCurrency: 'PHP',
  email: 'native@example.invalid'
};
const details: V2RechargeDetails = {
  number: '4242424242424242',
  expiry: '10/31',
  cvc: '123',
  name: 'Synthetic Buyer',
  email: binding.email,
  country: 'US',
  line1: '100 Test Avenue',
  line2: '',
  city: 'Eugene',
  state: 'OR',
  postal_code: '97402'
};
function request() {
  return {
    billing_address: { ...details },
    billing_country: 'US',
    billing_name: details.name,
    checkout_email: details.email,
    checkout_session_id: binding.checkoutId,
    currency: 'php',
    processor_entity: binding.entity,
    tax_id: null,
    unknown_secret: 'synthetic-private-tax-id'
  };
}
function response() {
  return {
    using_automatic_tax: false,
    private_field: 'response-secret',
    checkout_session: {
      checkout_session_id: binding.checkoutId,
      processor_entity: binding.entity,
      plan_name: 'chatgptplusplan',
      status: 'open',
      payment_status: 'unpaid',
      client_secret: 'response-secret',
      checkout_email: details.email,
      checkout_state: {
        id: binding.checkoutId,
        currency: 'php',
        taxIdInfo: null,
        total: { total: { minorUnitsAmount: 98214 } },
        lineItems: [
          {
            quantity: 1,
            recurring: { interval: 'month', intervalCount: 1 },
            secret: 'response-secret'
          }
        ],
        taxAmounts: [{ minorUnitsAmount: 0, tax_id: 'synthetic-private-tax-id' }],
        billingAddress: { name: details.name, email: details.email, address: { ...details } }
      }
    }
  };
}

describe('原生计税报价只保留双向绑定的完整白名单', () => {
  it('请求、响应和当前资料一致，投影可供原有最终报价核验', async () => {
    const projected = nativeBillingRequest(request(), binding);
    nativeBillingDetails(projected, details, binding);
    const document = nativeQuoteDocument(response(), projected, binding);
    expect(
      await verifyNativeDirectQuote(
        document,
        binding.checkoutId,
        binding.entity,
        'plus',
        details,
        'Total due today PHP 982.14\nTax PHP 0.00\nRenews PHP 982.14 / month',
        'PHP'
      )
    ).toMatchObject({
      quote: { today: { amount_minor: 98214 }, tax: { amount_minor: 0 } }
    });
    for (const sensitive of [
      'response-secret',
      'synthetic-private-tax-id',
      details.number,
      details.cvc
    ])
      expect(JSON.stringify([projected, document])).not.toContain(sensitive);
    expect(Object.keys(projected).sort()).toEqual(['billing', 'email']);
    expect(Object.keys(document).sort()).toEqual([
      'checkout_session_id',
      'checkout_state',
      'payment_status',
      'plan_name',
      'processor_entity',
      'status'
    ]);
    const state = paymentObject(document.checkout_state);
    expect(paymentObject(paymentObject(state.billingAddress).address)).toEqual({
      country: 'us',
      line1: '100 test avenue',
      line2: '',
      city: 'eugene',
      state: 'or',
      postal_code: '97402'
    });
  });
  it('官网省略tax_id时，仅在响应明确没有税号后恢复完整最终核价', async () => {
    const raw = request();
    Reflect.deleteProperty(raw, 'tax_id');
    const projected = nativeBillingRequest(raw, binding);
    const quote = response();
    Object.assign(quote.checkout_session.checkout_state, { taxIdInfo: null });
    const document = nativeQuoteDocument(quote, projected, binding);
    expect(
      await verifyNativeDirectQuote(
        document,
        binding.checkoutId,
        binding.entity,
        'plus',
        details,
        'Total due today PHP 982.14\nTax PHP 0.00\nRenews PHP 982.14 / month',
        'PHP'
      )
    ).toMatchObject({ quote: { today: { amount_minor: 98214 }, tax: { amount_minor: 0 } } });
    expect(JSON.stringify([projected, document])).not.toContain('response-secret');
    expect(JSON.stringify([projected, document])).not.toContain('synthetic-private-tax-id');
  });
  it.each([undefined, '', {}, [], 'synthetic-private-tax-id'])(
    '省略tax_id时，响应税号证明不为明确null就不能核价：%j',
    (taxIdInfo) => {
      const raw = request();
      Reflect.deleteProperty(raw, 'tax_id');
      const projected = nativeBillingRequest(raw, binding);
      const quote = response();
      if (taxIdInfo === undefined)
        Reflect.deleteProperty(quote.checkout_session.checkout_state, 'taxIdInfo');
      else Object.assign(quote.checkout_session.checkout_state, { taxIdInfo });
      expect(() => nativeQuoteDocument(quote, projected, binding)).toThrow(
        'native_billing_response_tax_context_unverified'
      );
    }
  );
  it.each([
    { checkout_session_id: 'oaics_other' },
    { processor_entity: 'other_entity' },
    { currency: 'USD' },
    { checkout_email: 'other@example.invalid' },
    { billing_country: 'CA' },
    { billing_country: undefined },
    { billing_name: '' },
    { billing_address: { ...details, state: '' } },
    { billing_address: { ...details, postal_code: '' } },
    { billing_address: { ...details, country: 'CA' } },
    { tax_id: undefined },
    { tax_id: '' },
    { tax_id: {} },
    { tax_id: 'synthetic-private-tax-id' }
  ])('拒绝请求绑定或完整账单不符：%j', (patch) => {
    expect(() => nativeBillingRequest({ ...request(), ...patch }, binding)).toThrow(
      /^native_billing_/
    );
  });
  it.each([
    { email: 'other@example.invalid' },
    { state: 'Oregon' },
    { name: 'Different Buyer' },
    { line1: '200 Different Avenue' },
    { line2: 'Unit 2' },
    { postal_code: '97403' },
    { country: 'CA' },
    { city: 'Portland' }
  ])('拒绝请求与当前填写资料不符：%j', (patch) => {
    expect(() =>
      nativeBillingDetails(
        nativeBillingRequest(request(), binding),
        { ...details, ...patch },
        binding
      )
    ).toThrow(/^native_billing_/);
  });
  it.each([
    ['checkout_session_id', 'oaics_other'],
    ['processor_entity', 'other_entity'],
    ['plan_name', 'chatgptgoplan'],
    ['status', 'expired'],
    ['payment_status', 'paid'],
    ['checkout_email', 'other@example.invalid']
  ])('拒绝响应原单身份或状态不符：%s', (key, value) => {
    const raw = response();
    Object.assign(raw.checkout_session, { [key]: value });
    expect(() =>
      nativeQuoteDocument(raw, nativeBillingRequest(request(), binding), binding)
    ).toThrow(/^native_billing_/);
  });
  it.each([
    { taxIdInfo: undefined },
    { taxIdInfo: '' },
    { taxIdInfo: {} },
    { taxIdInfo: 'synthetic-private-tax-id' },
    { id: 'oaics_other' },
    { currency: 'USD' },
    { total: {} },
    { total: { total: { minorUnitsAmount: -1 } } },
    { total: { total: { minorUnitsAmount: 982.14 } } },
    { total: { total: { minorUnitsAmount: Number.MAX_SAFE_INTEGER + 1 } } },
    { taxAmounts: [{ minorUnitsAmount: -1 }] },
    { taxAmounts: [{ minorUnitsAmount: '0' }] },
    { taxAmounts: [{ minorUnitsAmount: 98215 }] },
    { lineItems: [] },
    { lineItems: [{ quantity: 2, recurring: { interval: 'month' } }] },
    { lineItems: [{ quantity: 1, recurring: { interval: 'year' } }] },
    { lineItems: [{ quantity: 1, recurring: { interval: 'month', intervalCount: 2 } }] },
    { billingAddress: { name: details.name, address: { ...details, state: 'CA' } } },
    { billingAddress: { name: 'Other Buyer', address: { ...details } } },
    {
      billingAddress: {
        name: details.name,
        email: 'other@example.invalid',
        address: { ...details }
      }
    }
  ])('拒绝响应地址、币种、金额或周期不完整：%j', (patch) => {
    const raw = response();
    Object.assign(raw.checkout_session.checkout_state, patch);
    expect(() =>
      nativeQuoteDocument(raw, nativeBillingRequest(request(), binding), binding)
    ).toThrow(/^native_billing_/);
  });
  it('不接受旧GET或缺少计税响应封套', () => {
    expect(() =>
      nativeQuoteDocument(
        response().checkout_session,
        nativeBillingRequest(request(), binding),
        binding
      )
    ).toThrow('native_billing_response_invalid');
  });
  it('严格无税号锚点可以校验update_tax_id完整成功响应，空响应不算报价', () => {
    const projected = nativeBillingRequest(request(), binding);
    const session = response().checkout_session;
    expect(
      nativeQuoteDocument(
        { success: true, checkout_session: session },
        projected,
        binding,
        'tax_id'
      )
    ).toEqual(nativeQuoteDocument(response(), projected, binding));
    for (const raw of [{}, { success: true }, { success: false, checkout_session: session }])
      expect(() => nativeQuoteDocument(raw, projected, binding, 'tax_id')).toThrow(
        /^native_billing_/
      );
  });
});
