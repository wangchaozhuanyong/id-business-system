import { describe, expect, it } from 'vitest';
import { hash, safeDocument, assertFinalQuote } from './recharge-validation';
import { projectRechargePaymentRecord } from './recharge-payment-facts';
import {
  hasOfficialRechargeQuote,
  hasVerifiedRechargePayment,
  rechargeUpgradeRecheckBinding,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';

const upgradeId = `upg_${'b'.repeat(32)}`;
const quote = {
  plan: 'pro-5x',
  today: { amount: '80.00', amount_minor: 8000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '100.00', amount_minor: 10000, currency: 'USD' },
  renewal_interval: 'monthly'
};
const binding = {
  operation: 'subscription_upgrade',
  upgrade_identifier: upgradeId,
  target_plan: 'pro-5x',
  current_plan_before: 'plus',
  quote_authority: 'official_upgrade_preview',
  quote
};

describe('Plus升级Pro官方预览与原单付款绑定', () => {
  it('只读复查沿用原升级报价且不携带付款授权或银行卡', () => {
    expect(
      rechargeUpgradeRecheckBinding(
        { ...binding, safety: { authorizeSinglePayment: true }, card: 'synthetic' },
        'pro-5x'
      )
    ).toEqual(binding);
    expect(rechargeUpgradeRecheckBinding(binding, 'pro-20x')).toBeNull();
    expect(rechargeUpgradeRecheckBinding({ ...binding, quote: undefined }, 'pro-5x')).toBeNull();
    expect(
      rechargeUpgradeRecheckBinding({ ...binding, current_plan_before: undefined }, 'pro-5x')
    ).toBeNull();
  });
  it('升级预览只有绑定原账号升级操作与目标Pro档位才可确认', () => {
    expect(hasOfficialRechargeQuote(binding)).toBe(true);
    expect(hasOfficialRechargeQuote({ ...binding, current_plan_before: 'free' })).toBe(false);
    expect(hasOfficialRechargeQuote({ ...binding, upgrade_identifier: 'cs_fake' })).toBe(false);
    expect(() => assertFinalQuote(quote as never, 'pro-5x', 'official_upgrade_preview')).toThrow();
    expect(() =>
      assertFinalQuote(quote as never, 'pro-5x', 'official_upgrade_preview', binding)
    ).not.toThrow();
  });

  it('付款记录镜像必须同升级ID、同账号、同报价，并绑定实际invoice', () => {
    const job = { accountKey: 'a'.repeat(64), plan: 'pro-5x', result: binding };
    const payment = {
      ...binding,
      account_key: job.accountKey,
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'paid',
      upgrade_invoice_identifier: 'in_synthetic',
      payment_evidence: {
        kind: 'invoice',
        identifier: 'in_synthetic',
        amount_minor: 8000,
        currency: 'USD'
      }
    };
    const fileKey = `payments/${hash(upgradeId)}.json`;
    expect(projectRechargePaymentRecord(job, fileKey, payment)).toMatchObject({
      operation: 'subscription_upgrade',
      upgrade_identifier: upgradeId,
      payment_status: 'paid',
      payment_requests_sent: 1,
      upgrade_invoice_identifier: 'in_synthetic'
    });
    expect(projectRechargePaymentRecord(job, `payments/${hash('other')}.json`, payment)).toBeNull();
    expect(
      projectRechargePaymentRecord(job, fileKey, { ...payment, account_key: 'c'.repeat(64) })
    ).toBeNull();
    expect(
      projectRechargePaymentRecord(job, fileKey, {
        ...payment,
        upgrade_invoice_identifier: 'in_other'
      })
    ).toBeNull();
  });

  it('Go 升级 Plus 使用独立预览、原操作和付款证明，不借用 Plus 来源', () => {
    const goQuote = { ...quote, plan: 'plus' };
    const goUpgrade = {
      ...binding,
      quote: goQuote,
      current_plan_before: 'go',
      target_plan: 'plus'
    };
    expect(hasOfficialRechargeQuote(goUpgrade)).toBe(true);
    expect(rechargeUpgradeRecheckBinding(goUpgrade, 'plus')).toEqual(goUpgrade);
    expect(
      hasOfficialRechargeQuote({
        ...goUpgrade,
        target_plan: 'pro-20x',
        quote: { ...goQuote, plan: 'pro-20x' }
      })
    ).toBe(false);
    expect(
      hasOfficialRechargeQuote({ ...goUpgrade, quote_authority: 'official_checkout_response' })
    ).toBe(false);
    const job = {
      accountKey: 'a'.repeat(64),
      action: 'bitbrowser',
      plan: 'plus',
      result: goUpgrade
    };
    const payment = {
      ...goUpgrade,
      account_key: job.accountKey,
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'paid',
      upgrade_invoice_identifier: 'in_goupgrade',
      payment_evidence: {
        kind: 'invoice',
        identifier: 'in_goupgrade',
        amount_minor: 8000,
        currency: 'USD'
      }
    };
    const projected = projectRechargePaymentRecord(
      job,
      `payments/${hash(upgradeId)}.json`,
      payment
    );
    expect(projected).toMatchObject({
      current_plan_before: 'go',
      target_plan: 'plus',
      payment_requests_sent: 1
    });
    expect(
      projectRechargePaymentRecord(
        { ...job, result: { ...goUpgrade, current_plan_before: 'plus' } },
        `payments/${hash(upgradeId)}.json`,
        payment
      )
    ).toBeNull();
    expect(
      hasVerifiedRechargePayment(
        {
          ...payment,
          status: 'subscription_activated',
          payment_outcome: 'subscription_activated',
          account_matched: true,
          payment_requests_sent: 1
        },
        job
      )
    ).toBe(true);
    expect(
      hasVerifiedRechargePayment(
        {
          ...payment,
          status: 'subscription_activated',
          payment_outcome: 'subscription_activated',
          account_matched: false,
          payment_requests_sent: 1
        },
        job
      )
    ).toBe(false);
  });

  it('不能伪装checkout证据或将其他PI当本次升级成功', () => {
    expect(() =>
      safeDocument({
        payment_evidence: {
          kind: 'invoice',
          identifier: 'cs_fake',
          amount_minor: 1,
          currency: 'USD'
        }
      })
    ).toThrow();
    expect(
      rechargeUpgradePaymentReference({
        upgrade_payment_intent_identifier: 'pi_original',
        payment_evidence: { kind: 'payment_intent', identifier: 'pi_other' }
      })
    ).toBeNull();
  });
});
