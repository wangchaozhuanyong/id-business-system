import type { V2RechargePlan } from './contracts';
import type { V2RechargeDetails } from './contracts';
import {
  billingValues,
  directOfficialPlans,
  directPaymentMoney,
  parseDirectVisibleQuote,
  paymentFingerprint,
  paymentObject,
  verifyNativeDirectQuote,
  type PaymentDocument
} from './bitbrowser-payment-evidence';

const stripePage = /^\/v1\/payment_pages\/(cs_[A-Za-z0-9_]{1,180})(?:\/(?:init|update))?$/;
export const stripeQuoteCheckout = (path: string) => stripePage.exec(path)?.[1];

/** Retain only quote and billing facts in memory, never processor secrets or full responses. */
export function stripeQuoteDocument(raw: PaymentDocument, checkoutId: string) {
  if (
    raw.object !== 'checkout.session' ||
    raw.session_id !== checkoutId ||
    raw.mode !== 'subscription'
  )
    return undefined;
  const summary = paymentObject(raw.total_summary);
  const recurring = paymentObject(paymentObject(raw.recurring_details).total_summary);
  const invoice = paymentObject(raw.invoice);
  const lines = paymentObject(invoice.lines);
  const items = Array.isArray(lines.data) ? lines.data : [];
  const item = paymentObject(items[0]);
  const price = paymentObject(item.price);
  const customer = paymentObject(raw.customer);
  const address = paymentObject(customer.address);
  return {
    checkoutId,
    currency: raw.currency,
    due: summary.due,
    total: summary.total,
    taxes: Array.isArray(summary.total_tax_amounts)
      ? summary.total_tax_amounts.map((tax) => paymentObject(tax).amount)
      : undefined,
    renewal: recurring.total,
    invoiceDue: invoice.amount_due,
    invoiceTotal: invoice.total,
    invoiceCurrency: invoice.currency,
    itemCount: items.length,
    hasMore: lines.has_more,
    quantity: item.quantity,
    priceCurrency: price.currency,
    interval: paymentObject(price.recurring).interval,
    intervalCount: paymentObject(price.recurring).interval_count,
    billing: Object.fromEntries(
      ['country', 'state', 'city', 'line1', 'line2', 'postal_code'].map((key) => [
        key,
        address[key]
      ])
    )
  };
}
export type StripeQuoteDocument = NonNullable<ReturnType<typeof stripeQuoteDocument>>;

// Pro CS starts with the standard plan; the desired tier must still be verified before payment.
export const directCheckoutPlanMatches = (plan: V2RechargePlan, actual: unknown, id: string) =>
  actual === directOfficialPlans[plan] ||
  (id.startsWith('cs_') && plan.startsWith('pro-') && actual === directOfficialPlans['pro-5x']);

export async function verifyDirectCheckoutQuote(
  data: unknown,
  checkoutId: string,
  entity: string,
  plan: V2RechargePlan,
  details: V2RechargeDetails,
  text: string,
  lockedCurrency: string,
  stripe?: StripeQuoteDocument,
  tierVerified = false,
  billingVerified = false
) {
  if (plan.startsWith('pro-') && !tierVerified) throw new Error('official_pro_tier_unverified');
  if (!checkoutId.startsWith('cs_'))
    return verifyNativeDirectQuote(data, checkoutId, entity, plan, details, text, lockedCurrency);
  const envelope = paymentObject(data);
  const session = paymentObject(envelope.checkout_session ?? envelope);
  if (
    session.checkout_session_id !== checkoutId ||
    session.processor_entity !== entity ||
    !directCheckoutPlanMatches(plan, session.plan_name, checkoutId) ||
    session.status !== 'open' ||
    session.payment_status !== 'unpaid'
  )
    throw new Error('checkout_response_plan_unverified');
  if (!stripe) throw new Error('official_checkout_quote_unavailable');
  if (stripe.checkoutId !== checkoutId)
    throw new Error('official_checkout_quote_binding_unverified');
  const currency = String(stripe.currency ?? '').toUpperCase();
  if (
    currency !== lockedCurrency ||
    String(stripe.invoiceCurrency ?? '').toUpperCase() !== currency ||
    String(stripe.priceCurrency ?? '').toUpperCase() !== currency
  )
    throw new Error('payment_currency_mismatch');
  if (
    stripe.itemCount !== 1 ||
    stripe.hasMore !== false ||
    stripe.quantity !== 1 ||
    (stripe.interval !== undefined && stripe.interval !== 'month') ||
    (stripe.intervalCount !== undefined && stripe.intervalCount !== 1)
  )
    throw new Error('官网订阅周期未核实。');
  const quote = parseDirectVisibleQuote(text, currency, plan);
  const due = directPaymentMoney(currency, stripe.due).amount_minor;
  const total = directPaymentMoney(currency, stripe.total).amount_minor;
  const renewal = directPaymentMoney(currency, stripe.renewal).amount_minor;
  if (!Array.isArray(stripe.taxes)) throw new Error('官网税费未核实。');
  const tax = stripe.taxes.reduce<bigint>(
    (sum, amount) => sum + BigInt(directPaymentMoney(currency, amount).amount_minor),
    0n
  );
  if (
    due !== stripe.invoiceDue ||
    total !== stripe.invoiceTotal ||
    due !== quote.today!.amount_minor ||
    renewal !== quote.renewal!.amount_minor ||
    tax !== BigInt(quote.tax!.amount_minor)
  )
    throw new Error('官网页面与结算接口金额不一致。');
  // Customer.name is an account field; the current cardholder name is verified in the live form.
  if (!billingVerified) throw new Error('billing_fields_incomplete');
  const actual = billingValues(stripe.billing, details.name);
  const expected = billingValues(details, details.name);
  for (const field of ['country', 'state', 'city', 'line1', 'line2', 'postal_code'])
    if (actual[field] !== expected[field]) throw new Error(`official_billing_${field}_mismatch`);
  return {
    quote,
    billing_fingerprint: await paymentFingerprint({
      ...expected,
      card_last4: details.number.slice(-4),
      card_expiry: details.expiry
    })
  };
}
