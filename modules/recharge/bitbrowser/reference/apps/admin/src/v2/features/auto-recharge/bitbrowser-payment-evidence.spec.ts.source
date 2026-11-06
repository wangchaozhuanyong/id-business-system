import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeDetails } from './contracts';
import { DirectPaymentObserver } from './bitbrowser-payment-observer';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { createDirectPaymentSession } from './bitbrowser-payment-session';
import {
  billingValues,
  directPaymentDocumentDigest,
  directPaymentMoney,
  officialPaymentRead,
  parseDirectVisibleQuote,
  resolvedDirectVerificationCheckout,
  resolvedDirectVerificationPayment,
  resolvedDirectTerminalCheckout,
  resolvedDirectTerminalPayment,
  verifyNativeDirectQuote
} from './bitbrowser-payment-evidence';

const sid = 'oaics_synthetic';
const resolutionAccountKey = 'a'.repeat(64);
const verificationResolution = {
  operator_resolution: 'confirmed_verification_failed_no_charge',
  resolution_basis: 'operator_observed_official_failure',
  resolution_job_id: '11111111-1111-4111-8111-111111111111',
  source_job_id: '22222222-2222-4222-8222-222222222222',
  verification_job_id: '33333333-3333-4333-8333-333333333333',
  resolved_at: '2026-10-18T12:00:00.000Z'
};
function resolvedPaymentDocument() {
  return {
    ...verificationResolution,
    account_key: resolutionAccountKey,
    checkout_identifier: sid,
    target_plan: 'plus',
    payment_attempted: true,
    confirmation_requests_sent: 1,
    payment_requests_sent: 1,
    payment_status: 'unknown'
  };
}
function resolvedCheckoutDocument() {
  return {
    ...verificationResolution,
    checkout_identifier: sid,
    target_plan: 'plus',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0,
    payment_status: 'not_attempted'
  };
}

describe('官网明确拒付的服务端原单证明', () => {
  const proof = {
    kind: 'bound_payment_intent_declined',
    sourceJobId: '22222222-2222-4222-8222-222222222222',
    accountKey: resolutionAccountKey,
    checkoutIdentifier: sid,
    paymentIntentIdentifier: 'pi_SyntheticDecline',
    plan: 'plus',
    confirmedAt: '2026-10-19T00:00:00.000Z'
  };
  function documents() {
    return {
      payment: {
        account_key: resolutionAccountKey,
        target_plan: 'plus',
        checkout_identifier: sid,
        payment_status: 'declined',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        _official_terminal_failure_v1: { ...proof }
      },
      checkout: {
        target_plan: 'plus',
        checkout_identifier: sid,
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        _official_terminal_failure_v1: { ...proof }
      }
    };
  }
  it('仅相同账号、原单、付款意图和来源的两份服务端证明允许再次建单，保持原付款事实', () => {
    const { payment, checkout } = documents();
    const before = JSON.stringify({ payment, checkout });
    expect(resolvedDirectTerminalPayment(payment, resolutionAccountKey)).toBe(true);
    expect(resolvedDirectTerminalCheckout(checkout, payment, resolutionAccountKey, 'plus')).toBe(
      true
    );
    expect(JSON.stringify({ payment, checkout })).toBe(before);
  });
  it.each([
    { kind: 'operator_observed_failure' },
    { sourceJobId: 'invalid' },
    { accountKey: 'b'.repeat(64) },
    { checkoutIdentifier: 'oaics_other' },
    { paymentIntentIdentifier: 'not-an-intent' },
    { plan: 'go' },
    { confirmedAt: '2026-02-30T00:00:00.000Z' },
    { confirmedAt: 'not-a-date' }
  ])('无效或与付款不符的私有证明不能解除保护 %j', (patch) => {
    const { payment } = documents();
    expect(
      resolvedDirectTerminalPayment(
        { ...payment, _official_terminal_failure_v1: { ...proof, ...patch } },
        resolutionAccountKey
      )
    ).toBe(false);
  });
  it.each([
    { _official_terminal_failure_v1: undefined },
    { payment_status: 'unknown' },
    { payment_status: 'requires_action' },
    { payment_status: 'paid' },
    { account_key: 'b'.repeat(64) },
    { payment_requests_sent: 2 },
    { confirmation_requests_sent: '1' },
    { payment_attempted: false },
    { payment_evidence: { identifier: 'pi_Paid' } },
    { payment_intent_identifier: 'pi_Other' },
    { operation: 'subscription_upgrade' },
    { operator_resolution: 'confirmed_verification_failed_no_charge' }
  ])('未决、付款成功、不同意图及不完整回执不能借用失败证明 %j', (patch) => {
    expect(
      resolvedDirectTerminalPayment({ ...documents().payment, ...patch }, resolutionAccountKey)
    ).toBe(false);
  });
  it.each([
    { sourceJobId: '44444444-4444-4444-8444-444444444444' },
    { paymentIntentIdentifier: 'pi_Other' },
    { confirmedAt: '2026-10-19T00:01:00.000Z' }
  ])('根账本证明必须与付款账本完全相同 %j', (patch) => {
    const { payment, checkout } = documents();
    expect(
      resolvedDirectTerminalCheckout(
        { ...checkout, _official_terminal_failure_v1: { ...proof, ...patch } },
        payment,
        resolutionAccountKey,
        'plus'
      )
    ).toBe(false);
  });
  it('已存在的付款计数与成功证据不能被私有证明覆盖', () => {
    const { payment, checkout } = documents();
    for (const patch of [
      { payment_requests_sent: 1 },
      { payment_attempted: true },
      { payment_evidence: { identifier: 'pi_Paid' } },
      { target_plan: 'go' }
    ])
      expect(
        resolvedDirectTerminalCheckout(
          { ...checkout, ...patch },
          payment,
          resolutionAccountKey,
          'plus'
        )
      ).toBe(false);
  });
  it.each([
    ['go', 'plus'],
    ['plus', 'pro-5x'],
    ['plus', 'pro-20x'],
    ['plus', 'pro-500']
  ])('%s升级%s的已绑定明确拒付可结束付款保护，但不能冒充新订阅checkout证明', (source, target) => {
    const reference = 'upg_' + 'b'.repeat(32);
    const payment = {
      ...documents().payment,
      operation: 'subscription_upgrade',
      current_plan_before: source,
      target_plan: target,
      upgrade_identifier: reference,
      checkout_identifier: undefined,
      _official_terminal_failure_v1: { ...proof, plan: target, checkoutIdentifier: reference }
    };
    expect(resolvedDirectTerminalPayment(payment, resolutionAccountKey)).toBe(true);
    expect(resolvedDirectTerminalCheckout(payment, payment, resolutionAccountKey, 'plus')).toBe(
      false
    );
  });
  it.each([
    { current_plan_before: 'free' },
    { target_plan: 'go' },
    { upgrade_identifier: 'upg_invalid' },
    { upgrade_payment_intent_identifier: 'pi_Other' },
    { payment_status: 'requires_action' }
  ])('升级关系、付款绑定或终态不完整时仍保护 %j', (patch) => {
    const reference = 'upg_' + 'b'.repeat(32);
    expect(
      resolvedDirectTerminalPayment(
        {
          ...documents().payment,
          operation: 'subscription_upgrade',
          current_plan_before: 'plus',
          target_plan: 'pro-20x',
          upgrade_identifier: reference,
          checkout_identifier: undefined,
          _official_terminal_failure_v1: {
            ...proof,
            plan: 'pro-20x',
            checkoutIdentifier: reference
          },
          ...patch
        },
        resolutionAccountKey
      )
    ).toBe(false);
  });
});

describe('人工核实验证失败账本严格绑定', () => {
  it.each(['captured_official_failure', 'operator_observed_official_failure'])(
    '%s 仅识别同账号、同原单、单次付款的服务端处理标记且不改写原账本',
    (basis) => {
      const payment = { ...resolvedPaymentDocument(), resolution_basis: basis };
      const checkout = { ...resolvedCheckoutDocument(), resolution_basis: basis };
      const before = JSON.stringify({ payment, checkout });
      expect(resolvedDirectVerificationPayment(payment, resolutionAccountKey)).toBe(true);
      expect(
        resolvedDirectVerificationCheckout(checkout, payment, resolutionAccountKey, 'plus')
      ).toBe(true);
      expect(JSON.stringify({ payment, checkout })).toBe(before);
    }
  );
  it.each([
    { operator_resolution: undefined },
    { operator_resolution: 'confirmed_no_bank_request' },
    { resolution_basis: undefined },
    { resolution_basis: 'untrusted' },
    { resolution_job_id: 'invalid' },
    { source_job_id: undefined },
    { verification_job_id: '22222222-2222-4222-8222-222222222222' },
    { resolved_at: 'not-a-date' },
    { account_key: 'b'.repeat(64) },
    { checkout_identifier: '' },
    { target_plan: 'unsupported' },
    { payment_attempted: false },
    { payment_requests_sent: 0 },
    { payment_requests_sent: 2 },
    { payment_requests_sent: '1' },
    { confirmation_requests_sent: 0 },
    { confirmation_requests_sent: 2 },
    { payment_status: 'requires_action' },
    { payment_status: 'paid' },
    { payment_evidence: { identifier: 'pi_Paid' } },
    { operation: 'subscription_upgrade' },
    { upgrade_identifier: 'upg_Unexpected' },
    { status: 'subscription_activated' },
    { payment_outcome: 'paid_pending_activation' }
  ])('缺失、伪造或存在付款风险的原payment不解除保护 %j', (patch) => {
    expect(
      resolvedDirectVerificationPayment(
        { ...resolvedPaymentDocument(), ...patch },
        resolutionAccountKey
      )
    ).toBe(false);
  });
  it.each([
    { source_job_id: '44444444-4444-4444-8444-444444444444' },
    { resolution_job_id: '44444444-4444-4444-8444-444444444444' },
    { verification_job_id: '44444444-4444-4444-8444-444444444444' },
    { resolved_at: '2026-10-18T12:01:00.000Z' },
    { resolution_basis: 'captured_official_failure' },
    { checkout_identifier: 'oaics_other' },
    { account_key: 'b'.repeat(64) },
    { target_plan: 'go' },
    { plan: 'chatgptgoplan' },
    { payment_attempted: true },
    { confirmation_requests_sent: 1 },
    { payment_requests_sent: 1 },
    { payment_requests_sent: undefined },
    { payment_evidence: { identifier: 'pi_Paid' } }
  ])('根checkout与已核实payment不完全绑定时不能替换 %j', (patch) => {
    expect(
      resolvedDirectVerificationCheckout(
        { ...resolvedCheckoutDocument(), ...patch },
        resolvedPaymentDocument(),
        resolutionAccountKey,
        'plus'
      )
    ).toBe(false);
  });
  it('新单retry摘要与服务端递归规范一致，仅忽略network.observedAt', async () => {
    const value = {
      z: 3,
      a: { b: 2, a: 1 },
      network: { observedAt: 'volatile', country: 'PH' },
      list: [{ b: 2, a: 1 }],
      omitted: undefined
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          a: { a: 1, b: 2 },
          list: [{ a: 1, b: 2 }],
          network: { country: 'PH' },
          z: 3
        })
      )
      .digest('hex');
    expect(await directPaymentDocumentDigest(value)).toBe(expected);
    expect(await directPaymentDocumentDigest({ ...value, observedAt: 'preserved' })).not.toBe(
      expected
    );
    expect(await directPaymentDocumentDigest({ ...value, a: { a: 1, b: 9 } })).not.toBe(expected);
  });
});
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
const quoteText = 'Total due today PHP 982.14\nTax PHP 0.00\nRenews PHP 982.14 / month';
function document() {
  return {
    checkout_session_id: sid,
    processor_entity: 'openai_llc',
    plan_name: 'chatgptplusplan',
    status: 'open',
    payment_status: 'unpaid',
    checkout_state: {
      id: sid,
      currency: 'php',
      total: { total: { minorUnitsAmount: 98214 } },
      lineItems: [{ quantity: 1, recurring: { interval: 'month', intervalCount: 1 } }],
      taxAmounts: [{ minorUnitsAmount: 0 }],
      billingAddress: {
        name: details.name,
        address: {
          country: details.country,
          line1: details.line1,
          line2: details.line2,
          city: details.city,
          state: details.state,
          postal_code: details.postal_code
        }
      }
    }
  };
}
const verify = (data: unknown, text = quoteText, paymentDetails = details) =>
  verifyNativeDirectQuote(data, sid, 'openai_llc', 'plus', paymentDetails, text, 'PHP');
afterEach(() => vi.unstubAllGlobals());

describe('直连金额与完整官网报价证据', () => {
  it.each([
    ['USD', 12345, '123.45'],
    ['PHP', 98214, '982.14'],
    ['JPY', 12345, '12345'],
    ['VND', 30000, '30000'],
    ['USD', 0, '0.00']
  ])('以整数最小单位格式化%s', (currency, minor, amount) => {
    expect(directPaymentMoney(String(currency), minor)).toEqual({
      currency,
      amount_minor: minor,
      amount
    });
  });
  it.each([1.5, -1, NaN, Infinity, '100', 1_000_000_000_001, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝不可信最小单位金额 %s',
    (minor) => {
      expect(() => directPaymentMoney('USD', minor)).toThrow();
    }
  );
  it.each(['usd', 'US', '', 'USDD'])('拒绝不明确币种%s', (currency) => {
    expect(() => directPaymentMoney(currency, 100)).toThrow();
  });
  it('同一币种明确今日应付、税费和月续费才产生报价', () => {
    expect(parseDirectVisibleQuote(quoteText, 'PHP', 'plus')).toMatchObject({
      plan: 'plus',
      today: { amount_minor: 98214, currency: 'PHP' },
      tax: { amount_minor: 0 },
      renewal: { amount_minor: 98214 },
      renewal_interval: 'monthly'
    });
  });
  it('读取官网实测中文税额与独立金额行，仍要求明确月续费', () => {
    const text =
      'Go 套餐\n按月订阅订阅\nPHP 267.86\n税额 (0%)\nPHP 0.00\n今日应付金额\nPHP 267.86\n将按 每月 自动续订，直至取消。将按 PHP 267.86/月 收费。';
    expect(parseDirectVisibleQuote(text, 'PHP', 'go')).toMatchObject({
      today: { currency: 'PHP', amount_minor: 26786 },
      tax: { amount_minor: 0 },
      renewal: { amount_minor: 26786 },
      renewal_interval: 'monthly'
    });
    expect(() => parseDirectVisibleQuote(text.replace('/月', '/年'), 'PHP', 'go')).toThrow();
    expect(() => parseDirectVisibleQuote(text + '\n税额 (12%)\nPHP 32.14', 'PHP', 'go')).toThrow();
  });
  it.each([
    'Total due today USD 20.00\nRenews USD 20.00 / month',
    'Total due today USD 20.00\nTax USD 0.00\nRenews USD 20.00',
    'Total due today USD 20.00\nTax USD 0.00\nRenews USD 20.00 / year',
    'Total due today USD 20.00\nTax USD 0.00\nTax USD 0.00\nRenews USD 20.00 / month',
    'Total due today USD 20.00\nTotal due today USD 30.00\nTax USD 0.00\nRenews USD 20.00 / month',
    'Total due today USD 20.00\nTax USD 0.00\nRenews USD 20.00 / year\nRenews USD 20.00 / month',
    'Total due today €20.00\nTax €0.00\nRenews €20.00 / month',
    'Total due today PHP 20.00\nTax USD 0.00\nRenews USD 20.00 / month',
    'Total due today USD -20.00\nTax USD 0.00\nRenews USD 20.00 / month'
  ])('缺失、冲突、多条税费或年续费不能通过：%s', (text) => {
    expect(() => parseDirectVisibleQuote(text, 'USD', 'plus')).toThrow();
  });
  it('完整原单和账单绑定通过，指纹不包含卡号或安全码', async () => {
    const result = await verify(document());
    expect(result.quote.today?.amount_minor).toBe(98214);
    expect(result.billing_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(details.number);
    expect(result).not.toHaveProperty('cvc');
    expect(await verify({ checkout_session: document() })).toEqual(result);
  });
  it('原单接口缺少计税明细时独立报告，不凭可见金额放行', async () => {
    const { checkout_state: _state, ...withoutState } = document();
    void _state;
    await expect(verify(withoutState)).rejects.toThrow('official_checkout_quote_unavailable');
    const mismatch = document();
    mismatch.checkout_state.id = 'cs_other';
    await expect(verify(mismatch)).rejects.toThrow('official_checkout_quote_binding_unverified');
  });
  it.each([
    [
      '原单编号',
      (d: ReturnType<typeof document>) => {
        d.checkout_session_id = 'oaics_other';
      }
    ],
    [
      '处理实体',
      (d: ReturnType<typeof document>) => {
        d.processor_entity = 'openai_ie';
      }
    ],
    [
      '目标套餐',
      (d: ReturnType<typeof document>) => {
        d.plan_name = 'chatgptpro';
      }
    ],
    [
      '状态内编号',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.id = 'oaics_other';
      }
    ],
    [
      '原单关闭',
      (d: ReturnType<typeof document>) => {
        d.status = 'expired';
      }
    ],
    [
      '已付款',
      (d: ReturnType<typeof document>) => {
        d.payment_status = 'paid';
      }
    ],
    [
      '锁定币种',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.currency = 'MYR';
      }
    ],
    [
      '多个商品',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.lineItems.push(d.checkout_state.lineItems[0]!);
      }
    ],
    [
      '商品数量',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.lineItems[0]!.quantity = 2;
      }
    ],
    [
      '年度周期',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.lineItems[0]!.recurring.interval = 'year';
      }
    ],
    [
      '周期倍数',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.lineItems[0]!.recurring.intervalCount = 2;
      }
    ],
    [
      '接口金额变化',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.total.total.minorUnitsAmount++;
      }
    ],
    [
      '负数税额',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.taxAmounts[0]!.minorUnitsAmount = -1;
      }
    ],
    [
      '小数税额',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.taxAmounts[0]!.minorUnitsAmount = 0.5;
      }
    ],
    [
      '账单姓名',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.billingAddress.name = 'Other Buyer';
      }
    ],
    [
      '账单国家',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.billingAddress.address.country = 'MY';
      }
    ],
    [
      '账单街道',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.billingAddress.address.line1 += ' Other';
      }
    ],
    [
      '账单城市',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.billingAddress.address.city += ' Other';
      }
    ],
    [
      '账单邮编',
      (d: ReturnType<typeof document>) => {
        d.checkout_state.billingAddress.address.postal_code = '';
      }
    ]
  ] as const)('%s不一致时拒绝', async (_label, change) => {
    const data = document();
    change(data);
    await expect(verify(data)).rejects.toThrow();
  });
  it('地址空可选值规范化，必填姓名、州和邮编不能缺失', () => {
    expect(billingValues({ ...details, line2: null }, '  Synthetic   Buyer ')).toEqual(
      billingValues(details, details.name)
    );
    expect(() => billingValues({ ...details, state: '' }, details.name)).toThrow();
    expect(() => billingValues({ ...details, postal_code: '' }, details.name)).toThrow();
    expect(() => billingValues(details, '')).toThrow();
  });
  it('账单差异只报告字段分类，不输出官网或输入的具体值', async () => {
    const data = document();
    data.checkout_state.billingAddress.address.state = 'OR';
    await expect(verify(data)).rejects.toThrow('official_billing_state_mismatch');
  });
  it('卡尾号、有效期或完整地址变化改变指纹；安全码不进入指纹', async () => {
    const initial = await verify(document());
    expect(
      (await verify(document(), quoteText, { ...details, cvc: '456' })).billing_fingerprint
    ).toBe(initial.billing_fingerprint);
    expect(
      (await verify(document(), quoteText, { ...details, number: '5555555555554444' }))
        .billing_fingerprint
    ).not.toBe(initial.billing_fingerprint);
    expect(
      (await verify(document(), quoteText, { ...details, expiry: '11/39' })).billing_fingerprint
    ).not.toBe(initial.billing_fingerprint);
    const data = document();
    data.checkout_state.billingAddress.address.line1 = '456 New Test Street';
    expect(
      (await verify(data, quoteText, { ...details, line1: '456 New Test Street' }))
        .billing_fingerprint
    ).not.toBe(initial.billing_fingerprint);
  });
  it('页面旧金额不能通过接口新报价；同时变化后返回新的报价', async () => {
    const data = document();
    data.checkout_state.total.total.minorUnitsAmount = 99000;
    await expect(verify(data)).rejects.toThrow('官网页面与结算接口金额不一致');
    const next = await verify(data, quoteText.replaceAll('982.14', '990.00'));
    expect(next.quote.today?.amount_minor).toBe(99000);
  });
});

describe('原窗口官网读取绑定', () => {
  const identity = {
    accountId: 'synthetic-account',
    userId: 'synthetic-user',
    email: 'buyer@example.invalid'
  };
  const path = '/backend-api/payments/checkout/openai_llc/' + sid;
  function session(
    exp: unknown = Math.floor(Date.now() / 1000) + 3600,
    account = identity.accountId
  ) {
    const payload = Buffer.from(
      JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account } })
    ).toString('base64url');
    return {
      user: { id: identity.userId, email: identity.email },
      accessToken: 'synthetic.' + payload + '.synthetic'
    };
  }
  async function read(auth: ReturnType<typeof session>, failure?: Error) {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(auth), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(document()), { status: 200 }));
    if (failure)
      fetch
        .mockReset()
        .mockResolvedValueOnce(new Response(JSON.stringify(auth), { status: 200 }))
        .mockRejectedValueOnce(failure);
    vi.stubGlobal('location', new URL('https://chatgpt.com/checkout/openai_llc/' + sid));
    vi.stubGlobal('fetch', fetch);
    const result = await new Function(`return (${officialPaymentRead(identity, path)});`)();
    return { fetch, result };
  }
  it('同一官网用户、账号和有效凭据只读取原单GET', async () => {
    const { fetch, result } = await read(session());
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(path);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });
  it.each([
    [new TypeError('synthetic-private-value'), 'official_read_network_failed'],
    [new SyntaxError('synthetic-private-value'), 'official_read_response_invalid'],
    [new Error('synthetic-private-value'), 'official_read_failed']
  ])('官网读取异常只返回受控诊断，不回传异常正文', async (failure, reason) => {
    const { result, fetch } = await read(session(), failure as Error);
    expect(result).toEqual({ ok: false, status: 0, reason });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, 'future', -1, 0])(
    '缺失或无效expiry不能成为官网读取权限：%s',
    async (exp) => {
      const auth = session();
      const payload = Buffer.from(
        JSON.stringify({
          exp,
          'https://api.openai.com/auth': { chatgpt_account_id: identity.accountId }
        })
      ).toString('base64url');
      auth.accessToken = 'synthetic.' + payload + '.synthetic';
      const { fetch, result } = await read(auth);
      expect(result.ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it('官网账号或用户不匹配时不读取原单', async () => {
    const wrongAccount = await read(session(undefined, 'other-account'));
    expect(wrongAccount.result.ok).toBe(false);
    expect(wrongAccount.fetch).toHaveBeenCalledTimes(1);
    const auth = session();
    auth.user.id = 'other-user';
    const wrongUser = await read(auth);
    expect(wrongUser.result.ok).toBe(false);
    expect(wrongUser.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    'https://other.example.invalid/',
    '/backend-api/payments/checkout/confirm',
    '/backend-api/payments/checkout',
    '/backend-api/payments/checkout/openai_llc/oaics_synthetic#secret'
  ])('不生成未允许路径的读取脚本：%s', (input) => {
    expect(() => officialPaymentRead(identity, input)).toThrow();
  });
});

describe('付款观测只采纳唯一授权原单的官网证据', () => {
  const account = 'synthetic-account';
  const token = (accountId = account) =>
    'synthetic.' +
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId }
      })
    ).toString('base64url') +
    '.synthetic';
  function fixture(armed = true) {
    let handler:
      | ((method: string, params: Record<string, unknown>, session?: string) => void)
      | undefined;
    const bodies = new Map<string, object | string>();
    const ownedSessions = new Set(['owned', 'owned-child']);
    let requestId = 0;
    const cdp = {
      onEvent: vi.fn((callback) => {
        handler = callback;
        return () => {
          handler = undefined;
        };
      }),
      command: vi.fn(async (_method, params: { requestId: string }) => ({
        body:
          typeof bodies.get(params.requestId) === 'string'
            ? bodies.get(params.requestId)
            : JSON.stringify(bodies.get(params.requestId)),
        base64Encoded: false
      }))
    };
    const browser = {
      cdp,
      sessionId: 'owned',
      signal: new AbortController().signal,
      profileId: 'a'.repeat(32),
      identity: {
        accountId: account,
        userId: 'synthetic-user',
        email: 'buyer@example.invalid',
        plan: 'free'
      }
    } as unknown as VerifiedPaymentBrowser;
    const observer = new DirectPaymentObserver(
      browser,
      { checkoutId: sid, amount: 2000, currency: 'USD' },
      (session) => ownedSessions.has(session)
    );
    if (armed) observer.arm();
    async function response(
      path: string,
      body: object | string,
      options: {
        method?: string;
        data?: object;
        session?: string;
        status?: number;
        accountId?: string;
        stripe?: boolean;
        loadingFailed?: boolean;
        encodedDataLength?: number;
        contentLength?: number;
      } = {}
    ) {
      const id = String(++requestId);
      bodies.set(id, body);
      const session = options.session ?? 'owned';
      handler?.(
        'Network.requestWillBeSent',
        {
          requestId: id,
          request: {
            url: (options.stripe ? 'https://api.stripe.com' : 'https://chatgpt.com') + path,
            method: options.method ?? 'GET',
            postData: options.data ? JSON.stringify(options.data) : undefined,
            headers: {
              authorization: 'Bearer ' + token(options.accountId),
              'chatgpt-account-id': options.accountId ?? account
            }
          }
        },
        session
      );
      handler?.(
        'Network.responseReceived',
        {
          requestId: id,
          response: {
            status: options.status ?? 200,
            headers: { 'content-length': options.contentLength }
          }
        },
        session
      );
      handler?.(
        options.loadingFailed ? 'Network.loadingFailed' : 'Network.loadingFinished',
        { requestId: id, encodedDataLength: options.encodedDataLength },
        session
      );
      await observer.settle();
    }
    const confirm = (intent = 'pi_Synthetic1', options: Parameters<typeof response>[2] = {}) =>
      response(
        '/backend-api/payments/checkout/confirm',
        {
          type: 'payment_intent',
          client_secret: intent + '_secret_SYNTHETIC'
        },
        { method: 'POST', data: { checkout_session_id: sid }, ...options }
      );
    const success = (intent = 'pi_Synthetic1', options: Parameters<typeof response>[2] = {}) =>
      response(
        '/v1/payment_intents/' + intent + '/confirm',
        {
          object: 'payment_intent',
          id: intent,
          status: 'succeeded',
          amount_received: 2000,
          currency: 'usd'
        },
        { method: 'POST', stripe: true, ...options }
      );
    return {
      observer,
      cdp,
      response,
      confirm,
      success,
      detach: (session: string) => ownedSessions.delete(session)
    };
  }

  it.each([400, 401, 403, 429, 500])(
    '建单HTTP %s有界读取，只保留安全诊断且不暴露响应正文',
    async (status) => {
      const f = fixture();
      await f.response(
        '/backend-api/payments/checkout',
        { secret: 'private-body' },
        {
          method: 'POST',
          status
        }
      );
      expect(f.observer.checkoutFailure).toEqual({
        reason: 'official_checkout_http_failed',
        http_status: status,
        diagnostics: {
          checkout_error: {
            request_index: 1,
            body_state: 'parsed_json',
            attribution: 'unclassified',
            code_present: false,
            param_present: false,
            categories: []
          }
        }
      });
      expect(f.cdp.command).toHaveBeenCalledExactlyOnceWith(
        'Network.getResponseBody',
        { requestId: '1' },
        'owned',
        3000
      );
      expect(JSON.stringify(f.observer)).not.toContain('private-body');
      expect(f.observer.checkout).toBeUndefined();
      expect(f.observer.confirmationRequests).toBe(0);
    }
  );

  it('官网异常活动 HTTP400 被动回传分类，不重试建单或发起付款', async () => {
    const f = fixture(false);
    await f.response(
      '/backend-api/payments/checkout',
      { detail: 'Our systems have detected unusual activity. Please try again later.' },
      { method: 'POST', status: 400 }
    );
    expect(f.observer.checkoutFailure).toMatchObject({
      reason: 'official_checkout_http_failed',
      http_status: 400,
      diagnostics: {
        checkout_error: {
          request_index: 1,
          body_state: 'parsed_json',
          categories: ['unusual_activity'],
          attribution: 'message_pattern'
        }
      }
    });
    expect(f.observer.checkoutRequests).toBe(1);
    expect(f.observer.confirmationRequests).toBe(0);
    expect(f.observer.checkout).toBeUndefined();
    expect(f.cdp.command).toHaveBeenCalledExactlyOnceWith(
      'Network.getResponseBody',
      { requestId: '1' },
      'owned',
      3000
    );
    expect(JSON.stringify(f.observer)).not.toContain('Our systems');
  });

  it('HTTP400记录受控代码和参数，未识别的正文不会变成推断根因', async () => {
    const f = fixture(false);
    await f.response(
      '/backend-api/payments/checkout',
      {
        error: {
          code: 'invalid_request_error',
          param: 'plan_name',
          message: 'Unsupported plan PRIVATE_TOKEN'
        },
        sessionToken: 'PRIVATE_TOKEN'
      },
      { method: 'POST', status: 400 }
    );
    expect(f.observer.checkoutFailure?.diagnostics?.checkout_error).toEqual({
      request_index: 1,
      body_state: 'parsed_json',
      code: 'invalid_request_error',
      param: 'plan_name',
      code_present: true,
      param_present: true,
      categories: ['plan_validation'],
      attribution: 'structured_code'
    });
    expect(JSON.stringify(f.observer)).not.toContain('PRIVATE_TOKEN');
    expect(f.observer.checkoutRequests).toBe(1);
    expect(f.observer.confirmationRequests).toBe(0);
  });

  it.each(['body_unavailable', 'page_detached'] as const)(
    'HTTP拒绝不会被%s覆盖或重试',
    async (mode) => {
      const f = fixture(false);
      f.cdp.command.mockImplementationOnce(async () => {
        if (mode === 'page_detached') f.detach('owned');
        else throw new Error('PRIVATE_BODY');
        return { body: '{"code":"invalid_plan"}', base64Encoded: false };
      });
      await f.response('/backend-api/payments/checkout', {}, { method: 'POST', status: 400 });
      expect(f.observer.checkoutFailure).toMatchObject({
        reason: 'official_checkout_http_failed',
        http_status: 400,
        diagnostics: {
          checkout_error: {
            body_state: mode === 'page_detached' ? 'detached' : 'unavailable',
            attribution: 'unclassified'
          }
        }
      });
      expect(f.cdp.command).toHaveBeenCalledTimes(1);
      expect(f.observer.checkoutRequests).toBe(1);
      expect(f.observer.confirmationRequests).toBe(0);
    }
  );

  it.each(['encodedDataLength', 'contentLength'] as const)('超过%s边界不读取正文', async (key) => {
    const f = fixture(false);
    await f.response(
      '/backend-api/payments/checkout',
      { code: 'invalid_plan' },
      {
        method: 'POST',
        status: 400,
        [key]: 32769
      }
    );
    expect(f.observer.checkoutFailure).toMatchObject({
      reason: 'official_checkout_http_failed',
      http_status: 400,
      diagnostics: {
        checkout_error: { request_index: 1, body_state: 'oversized', attribution: 'unclassified' }
      }
    });
    expect(f.cdp.command).not.toHaveBeenCalled();
    expect(f.observer.checkoutRequests).toBe(1);
    expect(f.observer.confirmationRequests).toBe(0);
  });

  it('延迟读取时保留HTTP失败，关闭后不能采纳迟到正文', async () => {
    const f = fixture(false);
    let finish!: (value: { body: string; base64Encoded: boolean }) => void;
    f.cdp.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.response(
      '/backend-api/payments/checkout',
      {},
      { method: 'POST', status: 400 }
    );
    expect(f.observer.checkoutFailure?.diagnostics?.checkout_error.body_state).toBe('reading');
    f.observer.close();
    finish({ body: '{"code":"invalid_plan","secret":"PRIVATE"}', base64Encoded: false });
    await pending;
    expect(f.observer.checkoutFailure?.diagnostics?.checkout_error).toEqual({
      request_index: 1,
      body_state: 'detached',
      attribution: 'unclassified'
    });
    expect(JSON.stringify(f.observer)).not.toContain('PRIVATE');
  });

  it('只保留所属窗口 CS 最新的 Stripe 计税响应；失败请求使旧报价立即失效', async () => {
    const f = fixture(false);
    const stripe = {
      id: 'ppage_Synthetic',
      object: 'checkout.session',
      session_id: 'cs_Synthetic',
      mode: 'subscription',
      currency: 'php',
      client_secret: 'DO_NOT_RETAIN',
      total_summary: { due: 2000 },
      customer: { address: {} }
    };
    await f.response('/v1/payment_pages/cs_Synthetic/init', stripe, {
      stripe: true,
      method: 'POST'
    });
    expect(f.observer.stripeQuotes.get('cs_Synthetic')?.due).toBe(2000);
    expect(JSON.stringify([...f.observer.stripeQuotes])).not.toContain('DO_NOT_RETAIN');
    await f.response('/v1/payment_pages/cs_Synthetic/update', stripe, {
      stripe: true,
      status: 500
    });
    expect(f.observer.stripeQuotes.has('cs_Synthetic')).toBe(false);
    await f.response('/v1/payment_pages/cs_Synthetic', stripe, {
      stripe: true,
      session: 'unowned'
    });
    expect(f.observer.stripeQuotes.size).toBe(0);
    await f.response(
      '/v1/payment_pages/cs_Synthetic',
      { ...stripe, session_id: 'cs_other' },
      { stripe: true }
    );
    expect(f.observer.stripeQuotes.size).toBe(0);
    await f.response('/v1/payment_pages/cs_Synthetic', stripe, { stripe: true });
    f.observer.close();
    expect(f.observer.stripeQuotes.size).toBe(0);
    expect(f.observer.confirmationRequests).toBe(0);
  });

  it('晚到的旧税额不能覆盖后发请求，后发失败也不能复活旧报价', async () => {
    const f = fixture(false);
    const stripe = {
      id: 'ppage_Synthetic',
      object: 'checkout.session',
      session_id: 'cs_Synthetic',
      mode: 'subscription',
      currency: 'php',
      total_summary: { due: 2000 }
    };
    let finishOld!: (body: { body: string; base64Encoded: boolean }) => void;
    f.cdp.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const old = f.response('/v1/payment_pages/cs_Synthetic', stripe, { stripe: true });
    const current = f.response('/v1/payment_pages/cs_Synthetic/update', stripe, {
      stripe: true,
      status: 500
    });
    finishOld({ body: JSON.stringify(stripe), base64Encoded: false });
    await Promise.all([old, current]);
    expect(f.observer.stripeQuotes.size).toBe(0);
  });

  it('Stripe CS 确认路径也只采纳已授权原单的一次请求和同单付款凭据', async () => {
    const f = fixture(false);
    f.observer.bind('cs_Synthetic', 2000, 'USD');
    f.observer.arm();
    await f.response(
      '/v1/payment_pages/cs_Synthetic/confirm',
      {
        object: 'checkout.session',
        session_id: 'cs_Synthetic',
        payment_intent: { id: 'pi_Synthetic1', status: 'requires_action' }
      },
      { method: 'POST', stripe: true }
    );
    expect(f.observer.confirmationRequests).toBe(1);
    expect(f.observer.paymentStatus).toBe('requires_action');
    await f.success();
    expect(f.observer.paymentStatus).toBe('paid');
    expect(f.observer.evidence?.identifier).toBe('pi_Synthetic1');
  });

  it.each(['unarmed', 'other_checkout', 'response_mismatch', 'duplicate'])(
    'Stripe CS %s 不能当成正常授权付款',
    async (kind) => {
      const f = fixture(false);
      f.observer.bind('cs_Synthetic', 2000, 'USD');
      if (kind !== 'unarmed') f.observer.arm();
      const unexpected = vi.fn(async () => {});
      f.observer.onUnexpected = unexpected;
      const path = `/v1/payment_pages/${kind === 'other_checkout' ? 'cs_Other' : 'cs_Synthetic'}/confirm`;
      const body = {
        object: 'checkout.session',
        session_id: kind === 'response_mismatch' ? 'cs_Other' : 'cs_Synthetic',
        payment_intent: {
          id: 'pi_Synthetic1',
          status: 'succeeded',
          amount_received: 2000,
          currency: 'usd'
        }
      };
      await f.response(path, body, { method: 'POST', stripe: true });
      if (kind === 'duplicate') await f.response(path, body, { method: 'POST', stripe: true });
      expect(f.observer.failure).not.toBe('');
      expect(f.observer.evidence).toBeUndefined();
      if (kind === 'unarmed')
        expect(unexpected).toHaveBeenCalledWith(
          expect.objectContaining({
            checkout_identifier: 'cs_Synthetic',
            confirmation_requests_sent: 1
          })
        );
    }
  );
  it.each(['<html>private-body</html>', { message: 'private-body' }])(
    '无法解析建单响应时不保留正文：%j',
    async (body) => {
      const f = fixture();
      await f.response('/backend-api/payments/checkout', body, { method: 'POST' });
      expect(f.observer.checkoutFailure).toEqual({ reason: 'official_checkout_response_invalid' });
      expect(f.observer.checkout).toBeUndefined();
    }
  );
  it('建单连接失败仍保留未知结果，不伪装成未发出请求', async () => {
    const f = fixture();
    await f.response('/backend-api/payments/checkout', {}, { method: 'POST', loadingFailed: true });
    expect(f.observer.checkoutRequests).toBe(1);
    expect(f.observer.checkoutFailure).toEqual({ reason: 'official_checkout_network_failed' });
    expect(f.observer.checkout).toBeUndefined();
  });

  it('唯一原单确认关联唯一PI，再验证付款金额和币种', async () => {
    const f = fixture();
    await f.confirm();
    await f.success();
    expect(f.observer.confirmationRequests).toBe(1);
    expect(f.observer.failure).toBe('');
    expect(f.observer.evidence).toEqual({
      kind: 'payment_intent',
      identifier: 'pi_Synthetic1',
      amount_minor: 2000,
      currency: 'USD'
    });
    expect(f.observer.paymentStatus).toBe('paid');
  });
  it('只接受自有根页面或其已核验OOPIF，不采纳其他标签页', async () => {
    const f = fixture();
    await f.confirm('pi_Synthetic1', { session: 'other-page' });
    await f.success();
    expect(f.observer.evidence).toBeUndefined();
    expect(f.observer.confirmationRequests).toBe(0);
    const child = fixture();
    await child.confirm();
    await child.success('pi_Synthetic1', { session: 'owned-child' });
    expect(child.observer.paymentStatus).toBe('paid');
  });
  it('确认PI绑定持久化期间OOPIF已脱离所属页面，不再接受该响应中的付款证据', async () => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.observer.onBinding = async () => {
      entered();
      await persistence;
    };
    const pending = f.response(
      '/backend-api/payments/checkout/confirm',
      {
        payment_intent: {
          object: 'payment_intent',
          id: 'pi_Synthetic1',
          status: 'succeeded',
          amount_received: 2000,
          currency: 'usd'
        }
      },
      { method: 'POST', data: { checkout_session_id: sid }, session: 'owned-child' }
    );
    await persistenceStarted;
    f.detach('owned-child');
    release();
    await pending;
    expect(f.observer.evidence).toBeUndefined();
    expect(f.observer.paymentStatus).not.toBe('paid');
  });
  it('服务端消费一次确认前，任何付款响应均不能变成成功证据', async () => {
    const f = fixture(false);
    await f.confirm();
    await f.success();
    expect(f.observer.evidence).toBeUndefined();
    expect(f.observer.paymentStatus).not.toBe('paid');
  });
  it.each([true, false])(
    '未授权付款请求只为同账号=%s持久化未知付款事实，不采纳成功',
    async (sameAccount) => {
      const f = fixture(false);
      const unexpected = vi.fn(async () => {});
      f.observer.onUnexpected = unexpected;
      await f.confirm('pi_Synthetic1', { accountId: sameAccount ? account : 'other-account' });
      await f.success();
      expect(unexpected).toHaveBeenCalledTimes(sameAccount ? 1 : 0);
      if (sameAccount)
        expect(unexpected).toHaveBeenCalledWith({
          checkout_identifier: sid,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1
        });
      expect(f.observer.evidence).toBeUndefined();
      expect(f.observer.paymentStatus).not.toBe('paid');
    }
  );
  it('其他原单的确认不能关联PI', async () => {
    const f = fixture();
    await f.confirm('pi_Synthetic1', { data: { checkout_session_id: 'oaics_other' } });
    await f.success();
    expect(f.observer.failure).not.toBe('');
    expect(f.observer.evidence).toBeUndefined();
  });
  it('其他官网账号的确认不能关联PI', async () => {
    const f = fixture();
    await f.confirm('pi_Synthetic1', { accountId: 'other-account' });
    await f.success();
    expect(f.observer.failure).not.toBe('');
    expect(f.observer.evidence).toBeUndefined();
  });
  it('重复确认后保留首PI，不接受任何后续成功回包', async () => {
    const f = fixture();
    await f.confirm();
    await f.confirm('pi_Synthetic2');
    await f.success();
    await f.success('pi_Synthetic2');
    expect(f.observer.failure).not.toBe('');
    expect(f.observer.linkedIntent).toBe('pi_Synthetic1');
    expect(f.observer.evidence).toBeUndefined();
  });
  it('不同PI路径下返回同名对象不能伪装成原PI证据', async () => {
    const f = fixture();
    await f.confirm();
    await f.response(
      '/v1/payment_intents/pi_Other/confirm',
      {
        object: 'payment_intent',
        id: 'pi_Synthetic1',
        status: 'succeeded',
        amount_received: 2000,
        currency: 'usd'
      },
      { method: 'POST', stripe: true }
    );
    expect(f.observer.evidence).toBeUndefined();
  });
  it('确认回包显式PI与client secret中的PI冲突时不可关联', async () => {
    const f = fixture();
    await f.response(
      '/backend-api/payments/checkout/confirm',
      { payment_intent: { id: 'pi_Synthetic1', client_secret: 'pi_Other_secret_SYNTHETIC' } },
      { method: 'POST', data: { checkout_session_id: sid } }
    );
    await f.success();
    expect(f.observer.failure).not.toBe('');
    expect(f.observer.evidence).toBeUndefined();
  });
  it.each(['/v1/3ds2/authenticate', '/v1/3ds2/challenge_complete'])(
    '认证接口%s内嵌PI状态不能代替付款回执',
    async (path) => {
      const f = fixture();
      await f.confirm();
      await f.response(
        path,
        {
          payment_intent: {
            object: 'payment_intent',
            id: 'pi_Synthetic1',
            status: 'succeeded',
            amount_received: 2000,
            currency: 'usd'
          }
        },
        { stripe: true, method: 'POST' }
      );
      expect(f.observer.evidence).toBeUndefined();
    }
  );
  it('升级预览内嵌的PI状态不能代替本次付款回执', async () => {
    const f = fixture();
    await f.confirm();
    await f.response('/backend-api/subscriptions/update/preview', {
      payment_intent: {
        object: 'payment_intent',
        id: 'pi_Synthetic1',
        status: 'succeeded',
        amount_received: 2000,
        currency: 'usd'
      }
    });
    expect(f.observer.evidence).toBeUndefined();
  });
  it.each([
    { amount_received: 2001, currency: 'usd' },
    { amount_received: 2000, currency: 'myr' },
    { amount_received: 20.5, currency: 'usd' }
  ])('金额或币种不匹配不能证明付款 %o', async (patch) => {
    const f = fixture();
    await f.confirm();
    await f.response(
      '/v1/payment_intents/pi_Synthetic1/confirm',
      { object: 'payment_intent', id: 'pi_Synthetic1', status: 'succeeded', ...patch },
      { method: 'POST', stripe: true }
    );
    expect(f.observer.evidence).toBeUndefined();
  });
  it('非成功HTTP响应即使声称paid也不能通过', async () => {
    const f = fixture();
    await f.confirm();
    await f.success('pi_Synthetic1', { status: 400 });
    expect(f.observer.evidence).toBeUndefined();
  });
  it('只读PI回执也必须绑定原确认产生的PI', async () => {
    const f = fixture();
    await f.confirm();
    await f.response(
      '/v1/payment_intents/pi_Synthetic1',
      {
        object: 'payment_intent',
        id: 'pi_Synthetic1',
        status: 'succeeded',
        amount_received: 2000,
        currency: 'usd'
      },
      { stripe: true }
    );
    expect(f.observer.paymentStatus).toBe('paid');
  });
  it('requires_action仅表示待验证，后续同PI成功才可采证', async () => {
    const f = fixture();
    await f.confirm();
    await f.response(
      '/v1/payment_intents/pi_Synthetic1/confirm',
      { object: 'payment_intent', id: 'pi_Synthetic1', status: 'requires_action' },
      { stripe: true, method: 'POST' }
    );
    expect(f.observer.paymentStatus).toBe('requires_action');
    expect(f.observer.evidence).toBeUndefined();
    await f.success();
    expect(f.observer.paymentStatus).toBe('paid');
  });
  it('发票必须由本次确认明确关联、且已支付金额币种一致', async () => {
    const f = fixture();
    await f.response(
      '/backend-api/payments/checkout/confirm',
      { invoice_id: 'in_Synthetic' },
      { method: 'POST', data: { checkout_session_id: sid } }
    );
    await f.response(
      '/v1/invoices/in_Other',
      {
        object: 'invoice',
        id: 'in_Other',
        paid: true,
        status: 'paid',
        amount_paid: 2000,
        currency: 'usd'
      },
      { stripe: true }
    );
    expect(f.observer.evidence).toBeUndefined();
    await f.response(
      '/v1/invoices/in_Synthetic',
      {
        object: 'invoice',
        id: 'in_Synthetic',
        paid: true,
        status: 'paid',
        amount_paid: 2000,
        currency: 'usd'
      },
      { stripe: true }
    );
    expect(f.observer.evidence).toMatchObject({ kind: 'invoice', identifier: 'in_Synthetic' });
  });
  it('不同发票路径不能以正文伪装成已绑定发票', async () => {
    const f = fixture();
    await f.response(
      '/backend-api/payments/checkout/confirm',
      { invoice_id: 'in_Synthetic' },
      { method: 'POST', data: { checkout_session_id: sid } }
    );
    await f.response(
      '/v1/invoices/in_Other',
      {
        object: 'invoice',
        id: 'in_Synthetic',
        paid: true,
        status: 'paid',
        amount_paid: 2000,
        currency: 'usd'
      },
      { stripe: true }
    );
    expect(f.observer.evidence).toBeUndefined();
  });
});

describe('付款会话只枚举所属页面的跨进程frame', () => {
  async function fixture() {
    type Handler = (method: string, params: Record<string, unknown>, parent?: string) => void;
    let handler: Handler | undefined;
    const attached = new Set<string>();
    const main = {
      frame: { id: 'main', url: 'https://chatgpt.com/checkout/openai_llc/' + sid },
      childFrames: [{ frame: { id: 'outer', url: 'https://js.stripe.com/v3/outer' } }]
    };
    const outer = {
      frame: { id: 'outer', url: 'https://js.stripe.com/v3/outer' },
      childFrames: [{ frame: { id: 'inner', url: 'https://js.stripe.com/v3/inner' } }]
    };
    const inner = { frame: { id: 'inner', url: 'https://js.stripe.com/v3/inner' } };
    const trees: Record<string, object> = { owned: main, child: outer, nested: inner };
    const command = vi.fn(
      async (method: string, params: Record<string, unknown>, session: string) => {
        if (method === 'Target.setAutoAttach' && !attached.has(session)) {
          attached.add(session);
          if (session === 'owned')
            handler?.(
              'Target.attachedToTarget',
              { sessionId: 'child', targetInfo: { type: 'iframe', targetId: 'outer' } },
              'owned'
            );
          if (session === 'child')
            handler?.(
              'Target.attachedToTarget',
              { sessionId: 'nested', targetInfo: { type: 'iframe', targetId: 'inner' } },
              'child'
            );
        }
        if (method === 'Page.getFrameTree') return { frameTree: trees[session] };
        if (method === 'Page.createIsolatedWorld')
          return { executionContextId: params.frameId === 'main' ? 1 : 2 };
        if (method === 'Runtime.evaluate') return { result: { value: session } };
        return {};
      }
    );
    const cdp = {
      onEvent: (next: Handler) => {
        handler = next;
        return () => {
          handler = undefined;
        };
      },
      command,
      evaluate: vi.fn()
    };
    const browser = {
      cdp,
      sessionId: 'owned',
      signal: new AbortController().signal,
      profileId: 'a'.repeat(32),
      identity: {
        accountId: 'synthetic-account',
        userId: 'synthetic-user',
        email: 'buyer@example.invalid',
        plan: 'free'
      }
    } as unknown as VerifiedPaymentBrowser;
    const result = await createDirectPaymentSession(browser);
    return {
      ...result,
      command,
      event: (method: string, params: Record<string, unknown>, parent?: string) =>
        handler?.(method, params, parent)
    };
  }
  it('递归附着已属当前页的OOPIF，枚举子进程内部孙frame且不重复', async () => {
    const f = await fixture();
    const frames = await f.session.frames();
    expect(frames.map((frame) => frame.id).sort()).toEqual(['inner', 'main', 'outer']);
    expect(f.ownsSession('nested')).toBe(true);
    expect(f.command).toHaveBeenCalledWith('Page.getFrameTree', {}, 'child');
    expect(f.command).toHaveBeenCalledWith('Page.getFrameTree', {}, 'nested');
    const inner = frames.find((frame) => frame.id === 'inner')!;
    expect(await inner.evaluate('true')).toBe('nested');
    f.close();
  });
  it('其他标签页派生的iframe不能进入本页会话集合', async () => {
    const f = await fixture();
    f.event(
      'Target.attachedToTarget',
      { sessionId: 'foreign-child', targetInfo: { type: 'iframe', targetId: 'foreign-frame' } },
      'other-page'
    );
    expect(f.ownsSession('foreign-child')).toBe(false);
    expect(f.command.mock.calls.some(([, , session]) => session === 'foreign-child')).toBe(false);
    f.close();
  });
  it('父OOPIF脱离时取消所有子孙的付款证据资格', async () => {
    const f = await fixture();
    await f.session.frames();
    expect(f.ownsSession('nested')).toBe(true);
    f.event('Target.detachedFromTarget', { sessionId: 'child' }, 'owned');
    expect(f.ownsSession('child')).toBe(false);
    expect(f.ownsSession('nested')).toBe(false);
    f.close();
  });
});
