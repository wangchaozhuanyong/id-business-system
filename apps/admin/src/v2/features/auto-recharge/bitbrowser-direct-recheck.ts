import type { V2RechargePlan } from './contracts';
import type { V2RechargeBrowserRestore } from '@apple-business/shared';
import {
  createDirectPaymentSession,
  type VerifiedPaymentBrowser
} from './bitbrowser-payment-session';
import {
  directOfficialPlans,
  officialPaymentRead,
  paymentObject,
  type PaymentDocument
} from './bitbrowser-payment-evidence';
import { directPlanMatches } from './bitbrowser-direct-payment';

async function rawKey(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}
/** Official browser operations stay GET-only; paid proof advances only the existing ledger. */
export async function runDirectPaymentRecheck(
  browser: VerifiedPaymentBrowser,
  plan: V2RechargePlan,
  source: PaymentDocument,
  restored: V2RechargeBrowserRestore | undefined,
  persist: (input: object) => Promise<PaymentDocument>
): Promise<PaymentDocument> {
  const { session, close } = await createDirectPaymentSession(browser);
  const read = async (path: string) => {
    session.signal.throwIfAborted();
    const response = await session.evaluate<{ ok: boolean; data?: unknown }>(
      officialPaymentRead(browser.identity, path),
      16000
    );
    if (!response.ok) throw new Error('官网原单只读复查未完成，请保留原付款记录。');
    return paymentObject(response.data);
  };
  try {
    const data = await read('/backend-api/accounts/check/v4-2023-04-27');
    const node = paymentObject(paymentObject(data.accounts)[browser.identity.accountId]);
    const account = paymentObject(node.account);
    if (account.account_id !== undefined && account.account_id !== browser.identity.accountId)
      throw new Error('官网账号已变化，本次停止复查。');
    const raw = String(account.plan_type ?? node.plan_type ?? '');
    const current = raw === 'prolite' ? 'pro' : raw;
    const tier = raw === 'prolite' ? 5 : raw === 'pro' ? 20 : undefined;
    const report: PaymentDocument = {
      account_matched: true,
      transport: 'web_direct',
      mode: 'recheck',
      recheck_only: true,
      stage: 'original_payment_recheck',
      payment_attempted: true,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      current_plan: current,
      ...(tier ? { current_tier: tier } : {}),
      repeated_payment: 'blocked',
      payment_status: 'unknown'
    };
    const rows = (restored?.records ?? []).map(paymentObject);
    const records = rows.map((row) => paymentObject(row.document));
    const sid = String(source.checkout_identifier ?? restored?.originalCheckoutIdentifier ?? '');
    const upgrade = String(source.upgrade_identifier ?? '');
    const matches = records.filter((record) =>
      upgrade ? record.upgrade_identifier === upgrade : record.checkout_identifier === sid
    );
    const paymentFile = `payments/${await rawKey(upgrade || sid)}.json`;
    const paymentRows = rows.filter(
      (row) => row.fileKey === paymentFile && matches.includes(paymentObject(row.document))
    );
    const paymentRow = paymentRows.length === 1 ? paymentRows[0] : undefined;
    const record = paymentRow
      ? paymentObject(paymentRow.document)
      : (matches.find((value) => value.quote && value.payment_attempted === true) ?? matches[0]);
    if (upgrade) {
      if (!/^upg_[a-f0-9]{32}$/.test(upgrade) || !record) throw new Error('原升级记录绑定未核实。');
      const quote = paymentObject(record.quote ?? source.quote);
      const today = paymentObject(quote.today);
      const invoices = await read(
        `/backend-api/invoices?account_id=${encodeURIComponent(browser.identity.accountId)}&limit=100`
      );
      const list = invoices.data ?? invoices.invoices;
      if (!Array.isArray(list)) throw new Error('官网原升级发票列表未核实。');
      const evidence = list.map(paymentObject).filter((invoice) => {
        const linked =
          typeof invoice.payment_intent === 'string'
            ? invoice.payment_intent
            : paymentObject(invoice.payment_intent).id;
        return (
          invoice.object === 'invoice' &&
          typeof invoice.id === 'string' &&
          /^in_[A-Za-z0-9]+$/.test(invoice.id) &&
          (record.upgrade_invoice_identifier
            ? invoice.id === record.upgrade_invoice_identifier
            : Boolean(
                record.upgrade_payment_intent_identifier &&
                linked === record.upgrade_payment_intent_identifier
              )) &&
          invoice.status === 'paid' &&
          invoice.paid === true &&
          Number.isSafeInteger(invoice.amount_paid) &&
          invoice.amount_paid === today.amount_minor &&
          String(invoice.currency).toUpperCase() === today.currency
        );
      });
      if (evidence.length > 1) throw new Error('官网原升级付款证据存在歧义。');
      Object.assign(report, {
        operation: 'subscription_upgrade',
        upgrade_identifier: upgrade,
        quote,
        ...(record.upgrade_payment_intent_identifier
          ? {
              upgrade_payment_intent_identifier: record.upgrade_payment_intent_identifier,
              payment_intent_identifier: record.upgrade_payment_intent_identifier
            }
          : {}),
        ...(record.upgrade_invoice_identifier
          ? { upgrade_invoice_identifier: record.upgrade_invoice_identifier }
          : {})
      });
      if (evidence[0])
        Object.assign(report, {
          upgrade_invoice_identifier: evidence[0].id,
          payment_status: 'paid',
          payment_evidence: {
            kind: 'invoice',
            identifier: evidence[0].id,
            amount_minor: today.amount_minor,
            currency: today.currency
          }
        });
    } else {
      const entity = String(record?.processor_entity ?? source.processor_entity ?? '');
      if (
        !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(sid) ||
        !/^[a-z][a-z0-9_]{0,40}$/.test(entity) ||
        (restored?.originalCheckoutIdentifier && restored.originalCheckoutIdentifier !== sid)
      )
        throw new Error('官网原结账单绑定未核实。');
      const envelope = await read(`/backend-api/payments/checkout/${entity}/${sid}`);
      const original = paymentObject(envelope.checkout_session ?? envelope);
      if (
        original.checkout_session_id !== sid ||
        original.processor_entity !== entity ||
        original.plan_name !== directOfficialPlans[plan]
      )
        throw new Error('官网原单套餐或编号不一致。');
      Object.assign(report, {
        checkout_identifier: sid,
        processor_entity: entity,
        quote: record?.quote ?? source.quote
      });
      if (original.payment_status === 'paid') {
        const state = paymentObject(original.checkout_state);
        const amount = paymentObject(paymentObject(state.total).total).minorUnitsAmount;
        const currency = String(state.currency ?? '').toUpperCase();
        const today = paymentObject(paymentObject(report.quote).today);
        if (
          state.id !== sid ||
          !Number.isSafeInteger(amount) ||
          amount !== today.amount_minor ||
          currency !== today.currency
        )
          throw new Error('官网原单实付金额未核实。');
        Object.assign(report, {
          payment_status: 'paid',
          payment_evidence: {
            kind: 'checkout_session',
            identifier: sid,
            amount_minor: amount,
            currency
          }
        });
      } else if (original.payment_status === 'unpaid')
        Object.assign(report, { payment_status: 'unknown', checkout_status: original.status });
    }
    const activated = report.payment_status === 'paid' && directPlanMatches(plan, current, tier);
    const result: PaymentDocument = {
      ...report,
      status: activated
        ? 'subscription_activated'
        : report.payment_status === 'paid'
          ? 'paid_pending_activation'
          : 'payment_result_unknown',
      subscription_status: activated ? plan : 'not_verified',
      payment_outcome: activated
        ? 'subscription_activated'
        : report.payment_status === 'paid'
          ? 'paid_pending_activation'
          : 'payment_unknown'
    };
    if (result.payment_status === 'paid') {
      const accountKey = await rawKey(browser.identity.accountId);
      const originalDocument = paymentObject(paymentRow?.document);
      const originalQuote = paymentObject(originalDocument.quote);
      const originalToday = paymentObject(originalQuote.today);
      const counts = [
        originalDocument.payment_requests_sent,
        originalDocument.confirmation_requests_sent
      ];
      if (
        !paymentRow ||
        !Number.isSafeInteger(paymentRow.revision) ||
        Number(paymentRow.revision) < 1 ||
        originalDocument.account_key !== accountKey ||
        String(originalDocument.target_plan ?? 'plus') !== plan ||
        originalDocument.payment_attempted !== true ||
        counts.some((value) => value !== 0 && value !== 1) ||
        !counts.includes(1) ||
        originalQuote.plan !== plan ||
        !Number.isSafeInteger(originalToday.amount_minor) ||
        Number(originalToday.amount_minor) <= 0 ||
        !/^[A-Z]{3}$/.test(String(originalToday.currency)) ||
        JSON.stringify(result.quote) !== JSON.stringify(originalDocument.quote)
      )
        throw new Error('原付款账本或报价绑定缺失，本次无法确认复查收尾。');
      const next = { ...originalDocument };
      for (const field of [
        'status',
        'payment_status',
        'payment_evidence',
        'payment_outcome',
        'current_plan',
        'current_tier',
        'subscription_status',
        'upgrade_invoice_identifier'
      ] as const)
        if (result[field] !== undefined) next[field] = result[field];
      const saved = await persist({
        type: 'ledger',
        accountKey,
        fileKey: paymentFile,
        revision: paymentRow.revision,
        document: next
      });
      if (
        !Number.isSafeInteger(saved.revision) ||
        Number(saved.revision) <= Number(paymentRow.revision)
      )
        throw new Error('原付款账本更新结果待核实，请保留原单并重新只读复查。');
    }
    return result;
  } finally {
    close();
  }
}
