import { readV2RechargeManualSettlement, type V2RechargePlan } from '@apple-business/shared';
import { paymentObject } from './bitbrowser-payment-evidence';

export function resolvedDirectManualPayment(value: unknown, accountKey: string) {
  const document = paymentObject(value),
    proof = readV2RechargeManualSettlement(document);
  return Boolean(
    proof?.outcome === 'failure' &&
    proof.accountKey === accountKey &&
    document.account_key === accountKey &&
    proof.plan === (document.target_plan ?? 'plus') &&
    document.payment_attempted === true &&
    document.confirmation_requests_sent === 1 &&
    !document.payment_evidence &&
    document.payment_status !== 'paid' &&
    document.status !== 'subscription_activated' &&
    document.payment_outcome !== 'subscription_activated'
  );
}
export function resolvedDirectManualCheckout(
  value: unknown,
  paymentValue: unknown,
  accountKey: string,
  plan: V2RechargePlan
) {
  const checkout = paymentObject(value),
    payment = paymentObject(paymentValue);
  const proof = readV2RechargeManualSettlement(checkout),
    other = readV2RechargeManualSettlement(payment);
  return Boolean(
    proof &&
    other &&
    resolvedDirectManualPayment(payment, accountKey) &&
    Object.keys(proof).every(
      (key) => proof[key as keyof typeof proof] === other[key as keyof typeof other]
    ) &&
    Object.keys(proof).length === Object.keys(other).length &&
    proof.plan === plan &&
    (checkout.target_plan ?? 'plus') === plan &&
    (checkout.account_key === undefined || checkout.account_key === accountKey) &&
    checkout.checkout_identifier === payment.checkout_identifier &&
    !checkout.payment_evidence &&
    checkout.payment_status !== 'paid' &&
    checkout.status !== 'subscription_activated' &&
    checkout.payment_outcome !== 'subscription_activated'
  );
}
export function completedDirectManualDocument(value: unknown, accountKey: string) {
  const proof = readV2RechargeManualSettlement(value);
  return proof?.outcome === 'success' && proof.accountKey === accountKey;
}
