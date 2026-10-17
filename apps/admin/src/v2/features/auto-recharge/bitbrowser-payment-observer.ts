import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { paymentObject, type PaymentDocument } from './bitbrowser-payment-evidence';

/** Observes responses; it never intercepts, rewrites, or resends browser traffic. */
export class DirectPaymentObserver {
  checkout?: PaymentDocument;
  preview?: PaymentDocument;
  evidence?: {
    kind: 'payment_intent' | 'invoice' | 'checkout_session';
    identifier: string;
    amount_minor: number;
    currency: string;
  };
  linkedIntent = '';
  invoiceId = '';
  onBinding?: (binding: PaymentDocument) => Promise<void>;
  onUnexpected?: (facts: PaymentDocument) => Promise<void>;
  paymentStatus: 'unknown' | 'paid' | 'declined' | 'requires_action' = 'unknown';
  checkoutRequests = 0;
  confirmationRequests = 0;
  failure = '';
  private armed = false;
  private closed = false;
  private bindingReady = Promise.resolve();
  private receipts: PaymentDocument[] = [];
  private request = new Map<
    string,
    {
      path: string;
      method: string;
      session: string;
      status: number;
      data: PaymentDocument;
      confirmation: boolean;
    }
  >();
  private pending = new Set<Promise<void>>();
  private remove: () => void;
  constructor(
    private browser: VerifiedPaymentBrowser,
    private expected: {
      checkoutId?: string;
      amount?: number;
      currency?: string;
      upgrade?: { plan: string; methodId: string };
    },
    private ownsSession: (session: string) => boolean = (session) => session === browser.sessionId
  ) {
    this.remove = browser.cdp.onEvent((method, params, session) => {
      if (!session || !this.ownsSession(session) || this.closed) return;
      const key = `${session}:${String(params.requestId)}`;
      if (method === 'Network.requestWillBeSent') {
        const request = paymentObject(params.request);
        let url: URL;
        try {
          url = new URL(String(request.url));
        } catch {
          return;
        }
        const official =
          url.origin === 'https://chatgpt.com' &&
          /^\/backend-api\/(?:payments\/checkout|subscriptions\/update)(?:\/|$)/.test(url.pathname);
        const stripe =
          url.origin === 'https://api.stripe.com' &&
          /^\/v1\/(?:payment_intents\/pi_[A-Za-z0-9]+(?:\/confirm)?|invoices\/in_[A-Za-z0-9]+|3ds2\/(?:authenticate|challenge_complete))$/.test(
            url.pathname
          );
        if (!official && !stripe) return;
        let data: PaymentDocument = {};
        try {
          if (typeof request.postData === 'string' && request.postData.length <= 65000)
            data = paymentObject(JSON.parse(request.postData));
        } catch {
          /* An unreadable write is never repeated. */
        }
        let accountMatches = false;
        if (official) {
          const headers = paymentObject(request.headers);
          const header = (name: string) =>
            Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
          try {
            const token = String(header('authorization') ?? '');
            const encoded = token.startsWith('Bearer ') ? token.slice(7).split('.')[1] : undefined;
            const claims = encoded
              ? JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))
              : {};
            accountMatches =
              claims['https://api.openai.com/auth']?.chatgpt_account_id ===
                browser.identity.accountId &&
              (header('chatgpt-account-id') ?? browser.identity.accountId) ===
                browser.identity.accountId;
          } catch {
            accountMatches = false;
          }
        }
        if (
          official &&
          request.method === 'POST' &&
          url.pathname === '/backend-api/payments/checkout'
        ) {
          this.checkoutRequests++;
          if (!accountMatches) this.fail('checkout_account_unverified');
        }
        let confirmation = false;
        if (
          official &&
          request.method === 'POST' &&
          ['/backend-api/payments/checkout/confirm', '/backend-api/subscriptions/update'].includes(
            url.pathname
          )
        ) {
          this.confirmationRequests++;
          if (this.confirmationRequests > 1) this.fail('duplicate_payment_observed');
          if (!this.armed) this.fail('unexpected_payment_observed');
          if (!accountMatches) this.fail('payment_account_binding_changed');
          if (url.pathname === '/backend-api/payments/checkout/confirm') {
            if (!this.expected.checkoutId || data.checkout_session_id !== this.expected.checkoutId)
              this.fail('payment_order_binding_changed');
          } else if (
            !this.expected.upgrade ||
            data.account_id !== browser.identity.accountId ||
            data.updated_plan !== this.expected.upgrade.plan ||
            data.payment_method_id !== this.expected.upgrade.methodId
          )
            this.fail('payment_order_binding_changed');
          confirmation = this.armed && !this.failure && this.confirmationRequests === 1;
          if (accountMatches && (!this.armed || this.failure) && this.onUnexpected) {
            const observed: PaymentDocument = {
              payment_requests_sent: Math.min(this.confirmationRequests, 10),
              confirmation_requests_sent: Math.min(this.confirmationRequests, 10)
            };
            if (
              typeof data.checkout_session_id === 'string' &&
              /^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(data.checkout_session_id)
            )
              observed.checkout_identifier = data.checkout_session_id;
            const pending = this.onUnexpected(observed).catch(() =>
              this.fail('unexpected_payment_persistence_failed')
            );
            this.pending.add(pending);
            void pending.finally(() => this.pending.delete(pending));
          }
        }
        this.request.set(key, {
          path: url.pathname,
          method: String(request.method),
          session,
          status: 0,
          data,
          confirmation
        });
      }
      if (method === 'Network.responseReceived') {
        const item = this.request.get(key);
        if (item) item.status = Number(paymentObject(params.response).status);
      }
      if (method === 'Network.loadingFailed') this.request.delete(key);
      if (method === 'Network.loadingFinished' && this.request.has(key)) {
        const item = this.request.get(key)!;
        this.request.delete(key);
        const promise = this.read(String(params.requestId), item).catch(() => undefined);
        this.pending.add(promise);
        void promise.finally(() => this.pending.delete(promise));
      }
    });
  }
  private fail(reason: string) {
    this.failure ||= reason;
    this.evidence = undefined;
    this.paymentStatus = 'unknown';
  }
  bind(checkoutId: string, amount: number, currency: string) {
    this.expected = { checkoutId, amount, currency };
  }
  bindUpgrade(upgrade: { plan: string; methodId: string }, amount: number, currency: string) {
    this.expected = { upgrade, amount, currency };
  }
  arm() {
    if (this.failure || this.confirmationRequests || this.armed)
      throw new Error('本次付款状态已变化，已阻止重复提交。');
    this.armed = true;
  }
  private async read(
    requestId: string,
    item: {
      path: string;
      method: string;
      session: string;
      status: number;
      data: PaymentDocument;
      confirmation: boolean;
    }
  ) {
    const body = await this.browser.cdp.command(
      'Network.getResponseBody',
      { requestId },
      item.session
    );
    if (
      this.closed ||
      !this.ownsSession(item.session) ||
      typeof body.body !== 'string' ||
      body.body.length > 100000 ||
      body.base64Encoded
    )
      return;
    const raw = paymentObject(JSON.parse(body.body));
    if (item.status < 200 || item.status >= 300) return;
    if (item.path === '/backend-api/payments/checkout' && item.method === 'POST') {
      const value = paymentObject(raw.checkout_session ?? raw);
      if (
        !this.failure &&
        /^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(
          String(value.checkout_session_id ?? value.session_id)
        )
      )
        this.checkout = value;
    }
    if (item.path === '/backend-api/subscriptions/update/preview') this.preview = raw;
    if (
      item.path === '/backend-api/payments/checkout/confirm' ||
      item.path === '/backend-api/subscriptions/update'
    ) {
      if (!item.confirmation || this.failure) return;
      if (
        raw.checkout_session_id !== undefined &&
        raw.checkout_session_id !== this.expected.checkoutId
      ) {
        this.fail('payment_order_binding_changed');
        return;
      }
      const intent = paymentObject(raw.payment_intent);
      const secret = String(raw.client_secret ?? intent.client_secret ?? '');
      const match = /^(pi_[A-Za-z0-9]{1,180})_secret_[A-Za-z0-9]+$/.exec(secret);
      const ids = [
        intent.id,
        raw.payment_intent_id,
        match?.[1],
        raw.object === 'payment_intent' ? raw.id : undefined
      ].filter(
        (value): value is string =>
          typeof value === 'string' && /^pi_[A-Za-z0-9]{1,180}$/.test(value)
      );
      if (new Set(ids).size > 1) {
        this.fail('payment_intent_binding_changed');
        return;
      }
      const id = ids[0] ?? '';
      if (/^pi_[A-Za-z0-9]{1,180}$/.test(id)) {
        if (this.linkedIntent && this.linkedIntent !== id) {
          this.fail('payment_intent_binding_changed');
          return;
        }
        this.linkedIntent = id;
      }
      const invoices = [raw.invoice_id, paymentObject(raw.invoice).id].filter(
        (value): value is string =>
          typeof value === 'string' && /^in_[A-Za-z0-9]{1,180}$/.test(value)
      );
      if (new Set(invoices).size > 1) {
        this.fail('payment_intent_binding_changed');
        return;
      }
      const invoice = invoices[0] ?? '';
      if (/^in_[A-Za-z0-9]{1,180}$/.test(invoice)) {
        if (this.invoiceId && this.invoiceId !== invoice) {
          this.fail('payment_intent_binding_changed');
          return;
        }
        this.invoiceId = invoice;
      }
      if (this.linkedIntent || this.invoiceId) {
        const binding: PaymentDocument = {
          ...(this.linkedIntent ? { payment_intent_identifier: this.linkedIntent } : {}),
          ...(this.expected.upgrade && this.linkedIntent
            ? { upgrade_payment_intent_identifier: this.linkedIntent }
            : {}),
          ...(this.invoiceId ? { upgrade_invoice_identifier: this.invoiceId } : {})
        };
        this.bindingReady = (this.onBinding?.(binding) ?? Promise.resolve()).catch(() => {
          this.fail('payment_binding_persistence_failed');
        });
        await this.bindingReady;
      }
    }
    if (
      !this.armed ||
      this.failure ||
      this.confirmationRequests !== 1 ||
      !this.ownsSession(item.session)
    )
      return;
    const intent = raw.object === 'payment_intent' ? raw : paymentObject(raw.payment_intent);
    const pathIntent = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(?:\/confirm)?$/.exec(item.path);
    const pathInvoice = /^\/v1\/invoices\/(in_[A-Za-z0-9]+)$/.exec(item.path);
    if (!item.confirmation && !pathIntent && !pathInvoice) return;
    if (pathIntent && intent.id !== pathIntent[1]) return;
    if (pathInvoice && raw.id !== pathInvoice[1]) return;
    if ((pathIntent || pathInvoice) && !this.linkedIntent && !this.invoiceId) {
      if (this.receipts.length < 8)
        this.receipts.push({
          sourceSession: item.session,
          object: raw.object,
          id: raw.id,
          status: raw.status,
          amount_received: raw.amount_received,
          paid: raw.paid,
          amount_paid: raw.amount_paid,
          currency: raw.currency
        });
      return;
    }
    await this.bindingReady;
    if (this.failure || this.closed || !this.ownsSession(item.session)) return;
    this.acceptEvidence(raw);
    for (const receipt of this.receipts)
      if (this.ownsSession(String(receipt.sourceSession))) this.acceptEvidence(receipt);
    this.receipts = [];
  }
  private acceptEvidence(raw: PaymentDocument) {
    if (this.failure || this.closed || this.confirmationRequests !== 1) return;
    const intent = raw.object === 'payment_intent' ? raw : paymentObject(raw.payment_intent);
    if (intent.id === this.linkedIntent && this.linkedIntent) {
      if (intent.status === 'requires_action') this.paymentStatus = 'requires_action';
      if (['requires_payment_method', 'canceled'].includes(String(intent.status)))
        this.paymentStatus = 'declined';
      if (
        intent.status === 'succeeded' &&
        intent.amount_received === this.expected.amount &&
        String(intent.currency).toUpperCase() === this.expected.currency
      ) {
        this.evidence = {
          kind: 'payment_intent',
          identifier: this.linkedIntent,
          amount_minor: Number(this.expected.amount),
          currency: String(this.expected.currency)
        };
        this.paymentStatus = 'paid';
      }
    }
    if (
      raw.object === 'invoice' &&
      raw.id === this.invoiceId &&
      this.invoiceId &&
      raw.paid === true &&
      raw.status === 'paid' &&
      raw.amount_paid === this.expected.amount &&
      String(raw.currency).toUpperCase() === this.expected.currency
    ) {
      this.evidence = {
        kind: 'invoice',
        identifier: this.invoiceId,
        amount_minor: Number(this.expected.amount),
        currency: String(this.expected.currency)
      };
      this.paymentStatus = 'paid';
    }
  }
  async settle() {
    await Promise.all([...this.pending]);
  }
  close() {
    this.closed = true;
    this.remove();
    this.request.clear();
    this.receipts = [];
  }
}
