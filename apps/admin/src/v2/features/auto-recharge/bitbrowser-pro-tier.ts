import type { V2RechargePlan } from './contracts';
import { DirectBrowserError } from './bitbrowser-direct-api';
import {
  directOfficialPlans,
  parseDirectVisibleQuote,
  paymentObject
} from './bitbrowser-payment-evidence';

type TierPage = { kind: string; checkoutId?: string; entity?: string; text?: string };
type TierQuoteState = 'ready' | 'plan_pending' | 'page_pending' | 'amount_mismatch';

/** Preparation only: the full billing-bound quote still runs after filling the form. */
export function nativeProTierQuoteState(
  data: unknown,
  checkoutId: string,
  entity: string,
  plan: V2RechargePlan,
  currency: string,
  text: string
): TierQuoteState {
  const envelope = paymentObject(data);
  const session = paymentObject(envelope.checkout_session ?? envelope);
  if (
    session.checkout_session_id !== checkoutId ||
    session.processor_entity !== entity ||
    session.status !== 'open' ||
    session.payment_status !== 'unpaid'
  )
    throw new Error('官网原单状态或套餐未核实。');
  if (session.plan_name !== directOfficialPlans[plan]) return 'plan_pending';
  const state = paymentObject(session.checkout_state);
  if (!Object.keys(state).length) return 'page_pending';
  if (state.id !== checkoutId) throw new Error('official_checkout_quote_binding_unverified');
  if (String(state.currency ?? '').toUpperCase() !== currency)
    throw new Error('官网付款币种与锁定币种不一致。');
  const due = paymentObject(paymentObject(state.total).total).minorUnitsAmount;
  if (!Number.isSafeInteger(due) || Number(due) <= 0 || !Array.isArray(state.taxAmounts))
    throw new Error('官网账单金额未核实。');
  const tax = state.taxAmounts.reduce((sum: bigint, entry: unknown) => {
    const amount = paymentObject(entry).minorUnitsAmount;
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) throw new Error('官网税费未核实。');
    return sum + BigInt(Number(amount));
  }, 0n);
  if (tax > BigInt(Number(due))) throw new Error('官网税费未核实。');
  let quote;
  try {
    quote = parseDirectVisibleQuote(text, currency, plan);
  } catch {
    return 'page_pending';
  }
  return due === quote.today!.amount_minor && tax === BigInt(quote.tax!.amount_minor)
    ? 'ready'
    : 'amount_mismatch';
}

/** Select once, then read only. A stale native summary may reload the same unpaid order once. */
export async function prepareDirectProTier(input: {
  plan: V2RechargePlan;
  checkoutId: string;
  entity: string;
  currency: string;
  deadline: number;
  inspect: (action: 'tier' | 'verify_tier' | 'inspect') => Promise<TierPage>;
  read: () => Promise<unknown>;
  reload: () => Promise<void>;
  pause: () => Promise<void>;
  remaining: () => void;
}) {
  let quoteDeadline = input.deadline;
  let selected = false;
  let reloaded = false;
  let mismatchSince: number | undefined;
  let last: TierQuoteState | undefined;
  let reloadError: DirectBrowserError | undefined;
  while (Date.now() < quoteDeadline) {
    input.remaining();
    try {
      const tier = await input.inspect(selected ? 'verify_tier' : 'tier');
      if (['official_error', 'ambiguous_tier', 'checkout_mismatch'].includes(tier.kind))
        throw new Error('官网套餐档位未核实。');
      if (tier.kind === 'tier_changed' || tier.kind === 'tier_ready') selected = true;
      if (tier.kind === 'tier_ready') {
        // CS quotes are observed through Stripe, whose existing verifier remains authoritative.
        if (input.checkoutId.startsWith('cs_')) return;
        quoteDeadline = Math.min(quoteDeadline, Date.now() + 20_000);
        const data = await input.read();
        const page = await input.inspect('inspect');
        if (
          page.checkoutId !== input.checkoutId ||
          page.entity !== input.entity ||
          page.kind !== 'page'
        )
          throw new Error('existing_checkout_unavailable');
        // The read may overlap a manual tier change. Never reload or continue on that change.
        if ((await input.inspect('verify_tier')).kind !== 'tier_ready')
          throw new Error('官网套餐档位未核实。');
        last = nativeProTierQuoteState(
          data,
          input.checkoutId,
          input.entity,
          input.plan,
          input.currency,
          page.text ?? ''
        );
        reloadError = undefined;
        if (last === 'ready') return;
        if (last === 'amount_mismatch') {
          mismatchSince ??= Date.now();
          if (!reloaded && Date.now() - mismatchSince >= 2_000) {
            input.remaining();
            await input.reload();
            reloaded = true;
          }
        } else mismatchSince = undefined;
      }
    } catch (error) {
      input.remaining();
      // Reload replaces the execution context. Only read-only observations after our one
      // reload may wait within the existing quote budget; cancellation/disconnection must stop.
      if (
        !reloaded ||
        !(error instanceof DirectBrowserError) ||
        error.reason !== 'bitbrowser_direct_command_failed'
      )
        throw error;
      reloadError = error;
    }
    await input.pause();
  }
  if (reloadError) throw reloadError;
  throw new Error(
    last === 'amount_mismatch' ? '官网页面与结算接口金额不一致。' : '官网套餐档位未核实。'
  );
}
