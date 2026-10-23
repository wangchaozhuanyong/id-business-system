import type { V2RechargeDetails, V2RechargePlan } from './contracts';
import {
  billingValues,
  directOfficialPlans,
  paymentObject,
  type PaymentDocument
} from './bitbrowser-payment-evidence';

export const NATIVE_QUOTE_BODY_LIMIT = 100_000;
export interface NativeQuoteBinding {
  checkoutId: string;
  entity: string;
  plan: V2RechargePlan;
  lockedCurrency: string;
  email: string;
}
export interface NativeBillingRequest {
  billing: Record<string, string>;
  email: string;
}
export interface NativeBillingObservation {
  version: number;
  pending: boolean;
  observed: boolean;
  changedAt: number;
  document?: PaymentDocument;
  error?: string;
}
const need = (condition: unknown, reason: string) => {
  if (!condition) throw new Error('native_billing_' + reason);
};
const email = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const sameBilling = (actual: Record<string, string>, expected: Record<string, string>) =>
  Object.keys(expected).every((key) => actual[key] === expected[key]);

/** Project only the expected account/order and complete billing facts; discard tax IDs. */
export function nativeBillingRequest(data: unknown, binding: NativeQuoteBinding) {
  const raw = paymentObject(data);
  need(!Object.hasOwn(raw, 'tax_id') || raw.tax_id === null, 'tax_context_unverified');
  need(raw.checkout_session_id === binding.checkoutId, 'request_order_mismatch');
  need(raw.processor_entity === binding.entity, 'request_entity_mismatch');
  need(
    String(raw.currency ?? '').toUpperCase() === binding.lockedCurrency,
    'request_currency_mismatch'
  );
  need(
    email(raw.checkout_email) === email(binding.email) && email(binding.email),
    'request_email_mismatch'
  );
  let billing: Record<string, string>;
  try {
    billing = billingValues(raw.billing_address, raw.billing_name);
  } catch {
    throw new Error('native_billing_request_address_invalid');
  }
  need(
    typeof raw.billing_country === 'string' &&
      raw.billing_country.trim().toLowerCase() === billing.country,
    'request_country_mismatch'
  );
  return { billing, email: email(raw.checkout_email) } satisfies NativeBillingRequest;
}

export function nativeBillingDetails(
  request: NativeBillingRequest,
  details: V2RechargeDetails,
  binding: NativeQuoteBinding
) {
  need(
    email(details.email) === email(binding.email) && request.email === email(details.email),
    'details_email_mismatch'
  );
  let expected: Record<string, string>;
  try {
    expected = billingValues(details, details.name);
  } catch {
    throw new Error('native_billing_details_address_invalid');
  }
  need(sameBilling(request.billing, expected), 'details_address_mismatch');
}

/** No response objects or secrets are retained: return the native verifier's exact whitelist. */
export function nativeQuoteDocument(
  data: unknown,
  request: NativeBillingRequest,
  binding: NativeQuoteBinding,
  kind: 'taxes' | 'tax_id' = 'taxes'
): PaymentDocument {
  const envelope = paymentObject(data);
  const session = paymentObject(envelope.checkout_session);
  const state = paymentObject(session.checkout_state);
  need(
    kind === 'taxes'
      ? typeof envelope.using_automatic_tax === 'boolean'
      : envelope.success === true,
    'response_invalid'
  );
  // update_tax_id omits the empty field after a successful explicit null request.
  // The observer accepts that kind only with a verified null request and its latest taxes anchor.
  // Initial taxes responses must still explicitly prove the absence of a tax ID.
  need(
    state.taxIdInfo === null || (kind === 'tax_id' && !Object.hasOwn(state, 'taxIdInfo')),
    'response_tax_context_unverified'
  );
  need(
    session.checkout_session_id === binding.checkoutId && state.id === binding.checkoutId,
    'response_order_mismatch'
  );
  need(session.processor_entity === binding.entity, 'response_entity_mismatch');
  need(session.plan_name === directOfficialPlans[binding.plan], 'response_plan_mismatch');
  need(session.status === 'open' && session.payment_status === 'unpaid', 'response_status_invalid');
  need(
    String(state.currency ?? '').toUpperCase() === binding.lockedCurrency,
    'response_currency_mismatch'
  );
  const address = paymentObject(state.billingAddress);
  let billing: Record<string, string>;
  try {
    billing = billingValues(address.address, address.name);
  } catch {
    throw new Error('native_billing_response_address_invalid');
  }
  need(sameBilling(billing, request.billing), 'response_address_mismatch');
  for (const value of [session.checkout_email, state.checkout_email, address.email])
    if (value !== undefined) need(email(value) === request.email, 'response_email_mismatch');
  const lines = state.lineItems;
  const taxes = state.taxAmounts;
  const due = paymentObject(paymentObject(state.total).total).minorUnitsAmount;
  need(Number.isSafeInteger(due) && Number(due) >= 0, 'response_amount_invalid');
  need(
    Array.isArray(lines) && lines.length === 1 && Array.isArray(taxes),
    'response_amount_invalid'
  );
  const item = paymentObject((lines as unknown[])[0]);
  const recurring = paymentObject(item.recurring);
  need(
    item.quantity === 1 && recurring.interval === 'month' && (recurring.intervalCount ?? 1) === 1,
    'response_period_invalid'
  );
  const taxAmounts = (taxes as unknown[]).map((tax) => {
    const amount = paymentObject(tax).minorUnitsAmount;
    need(Number.isSafeInteger(amount) && Number(amount) >= 0, 'response_tax_invalid');
    return { minorUnitsAmount: amount };
  });
  need(
    taxAmounts.reduce((sum, tax) => sum + BigInt(Number(tax.minorUnitsAmount)), 0n) <=
      BigInt(Number(due)),
    'response_tax_invalid'
  );
  return {
    checkout_session_id: binding.checkoutId,
    processor_entity: binding.entity,
    plan_name: directOfficialPlans[binding.plan],
    status: 'open',
    payment_status: 'unpaid',
    checkout_state: {
      id: binding.checkoutId,
      currency: binding.lockedCurrency,
      total: { total: { minorUnitsAmount: due } },
      lineItems: [{ quantity: 1, recurring: { interval: 'month', intervalCount: 1 } }],
      taxAmounts,
      billingAddress: {
        name: billing.name,
        address: Object.fromEntries(
          ['country', 'line1', 'line2', 'city', 'state', 'postal_code'].map((key) => [
            key,
            billing[key]
          ])
        )
      }
    }
  };
}
