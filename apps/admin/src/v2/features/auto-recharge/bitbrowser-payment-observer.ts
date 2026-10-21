import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import type { V2CheckoutDiagnostic } from '@apple-business/shared';
import {
  CHECKOUT_ERROR_BODY_LIMIT,
  checkoutErrorDiagnostic
} from './bitbrowser-checkout-diagnostic';
import { paymentObject, type PaymentDocument } from './bitbrowser-payment-evidence';
import type { V2RechargeDetails, V2RechargePlan } from './contracts';
import {
  NATIVE_QUOTE_BODY_LIMIT,
  nativeBillingDetails,
  nativeBillingRequest,
  nativeQuoteDocument,
  type NativeBillingObservation,
  type NativeBillingRequest,
  type NativeQuoteBinding
} from './bitbrowser-native-quote';
import {
  stripeQuoteCheckout,
  stripeQuoteDocument,
  type StripeQuoteDocument
} from './bitbrowser-stripe-quote';

const NATIVE_POST_DATA_LIMIT = 65000;
type NativeBodyState =
  | 'none'
  | 'provided'
  | 'omitted'
  | 'retrieved'
  | 'missing'
  | 'encoded'
  | 'invalid'
  | 'oversized'
  | 'unavailable';
interface NativeBodySource {
  state: NativeBodyState;
  requestId?: string;
  session: string;
}

type NativeAuthIssue =
  | 'none'
  | 'token_missing'
  | 'token_invalid'
  | 'token_account_mismatch'
  | 'account_header_missing'
  | 'account_header_mismatch'
  | 'token_expired_or_missing';

interface NativeAuthProof {
  issue: NativeAuthIssue;
  expiresAt: number;
  recoverable: boolean;
}

// Retain only verification results, never the Authorization/Cookie header values.
function nativeAuthProof(headers: PaymentDocument, accountId: string): NativeAuthProof {
  const header = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const failed = (issue: NativeAuthIssue): NativeAuthProof => ({
    issue,
    expiresAt: 0,
    recoverable: false
  });
  try {
    const authorization = String(header('authorization') ?? '');
    if (!authorization.startsWith('Bearer ')) return failed('token_missing');
    if (authorization.length > 16384) return failed('token_invalid');
    const encoded = authorization.slice(7).split('.')[1];
    if (!encoded) return failed('token_invalid');
    const claims = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    if (claims['https://api.openai.com/auth']?.chatgpt_account_id !== accountId)
      return failed('token_account_mismatch');
    const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      return failed('token_expired_or_missing');
    if (header('chatgpt-account-id') === undefined)
      return { issue: 'account_header_missing', expiresAt, recoverable: true };
    if (header('chatgpt-account-id') !== accountId) return failed('account_header_mismatch');
    return { issue: 'none', expiresAt, recoverable: false };
  } catch {
    return failed('token_invalid');
  }
}

function resolvedNativeAuth(base: NativeAuthProof, wire?: NativeAuthProof): NativeAuthProof {
  // Only an otherwise verified token with an omitted account header can be completed.
  // A conflicting base token/header is never repaired by a later event.
  if (!wire || (base.issue !== 'none' && !base.recoverable)) return base;
  if (wire.issue !== 'none') return { ...wire, recoverable: false };
  return {
    issue: 'none',
    expiresAt: Math.min(base.expiresAt, wire.expiresAt),
    recoverable: false
  };
}

function combinedNativeWire(previous: NativeAuthProof | undefined, next: NativeAuthProof) {
  if (!previous || next.issue !== 'none') return next;
  if (previous.issue !== 'none') return previous;
  return { ...next, expiresAt: Math.min(previous.expiresAt, next.expiresAt) };
}

interface NativeRequestObservation {
  bodyState: NativeBodyState;
  orderState: 'missing' | 'matches' | 'mismatch';
  bodyWait?: Promise<void>;
  authIssue: NativeAuthIssue;
  authExpiresAt: number;
  authPending: boolean;
  authFinalized: boolean;
  authWait?: Promise<void>;
  releaseAuth?: () => void;
  generation: number;
  version: number;
  sequence: number;
  kind: 'taxes' | 'tax_id';
  billing?: NativeBillingRequest;
  valid: boolean;
}

/** Observes responses; it never intercepts, rewrites, or resends browser traffic. */
export class DirectPaymentObserver {
  checkout?: PaymentDocument;
  preview?: PaymentDocument;
  stripeQuotes = new Map<string, StripeQuoteDocument>();
  private stripeVersions = new Map<string, number>();
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
  checkoutFailure?: {
    reason:
      | 'official_checkout_http_failed'
      | 'official_checkout_response_invalid'
      | 'official_checkout_network_failed';
    http_status?: number;
    diagnostics?: { checkout_error: V2CheckoutDiagnostic };
  };
  confirmationRequests = 0;
  failure = '';
  private armed = false;
  private closed = false;
  private bindingReady = Promise.resolve();
  private receipts: PaymentDocument[] = [];
  private nativeBinding?: NativeQuoteBinding;
  private nativeGeneration = 0;
  private nativeVersion = 0;
  private nativeChangedAt = 0;
  private nativeObserved = false;
  private nativeTaxesSequence = 0;
  private nativeInflight = new Set<number>();
  private nativeError?: string;
  private nativeAuthIssue: NativeAuthIssue = 'none';
  private nativeBodyState: NativeBodyState = 'none';
  private nativeRequestKind: 'none' | 'taxes' | 'tax_id' = 'none';
  private nativeOrderState: 'missing' | 'matches' | 'mismatch' = 'missing';
  private nativeBodiesRecovered = 0;
  private nativeWireEarly = new Map<string, NativeAuthProof>();
  private nativeAuthRequests = new Map<
    string,
    { base: NativeAuthProof; item: NativeRequestObservation; wire?: NativeAuthProof }
  >();
  private nativeBillingAnchor?: NativeBillingRequest;
  private nativeBillingAnchorWait?: Promise<void>;
  private nativeQuoteVersion = 0;
  private nativeQuote?: { request: NativeBillingRequest; document: PaymentDocument };
  private request = new Map<
    string,
    {
      path: string;
      method: string;
      session: string;
      status: number;
      data: PaymentDocument;
      confirmation: boolean;
      checkoutIndex?: number;
      responseTooLarge?: boolean;
      stripeVersion?: number;
      nativeBilling?: NativeRequestObservation;
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
      if (method === 'Network.requestWillBeSentExtraInfo' && this.nativeBinding) {
        const proof = nativeAuthProof(paymentObject(params.headers), browser.identity.accountId);
        const tracked = this.nativeAuthRequests.get(key);
        if (tracked) this.applyNativeWire(tracked, proof);
        else {
          this.nativeWireEarly.set(key, combinedNativeWire(this.nativeWireEarly.get(key), proof));
          if (this.nativeWireEarly.size > 64)
            this.nativeWireEarly.delete(this.nativeWireEarly.keys().next().value!);
        }
        return;
      }
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
          /^\/v1\/(?:payment_pages\/cs_[A-Za-z0-9_]+(?:\/(?:init|update|confirm))?|payment_intents\/pi_[A-Za-z0-9]+(?:\/confirm)?|invoices\/in_[A-Za-z0-9]+|3ds2\/(?:authenticate|challenge_complete))$/.test(
            url.pathname
          );
        if (!official && !stripe) return;
        let data: PaymentDocument = {};
        let bodyState: NativeBodyState = 'omitted';
        try {
          if (typeof request.postData === 'string') {
            bodyState =
              request.postData.length <= NATIVE_POST_DATA_LIMIT ? 'provided' : 'oversized';
            if (bodyState === 'provided') data = paymentObject(JSON.parse(request.postData));
          }
        } catch {
          bodyState = 'invalid';
          /* An unreadable write is never repeated. */
        }
        let accountMatches = false;
        let nativeAuth: NativeAuthProof = {
          issue: 'token_missing',
          expiresAt: 0,
          recoverable: false
        };
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
          nativeAuth = nativeAuthProof(headers, browser.identity.accountId);
        }
        if (
          official &&
          request.method === 'POST' &&
          url.pathname === '/backend-api/payments/checkout'
        ) {
          this.checkoutRequests++;
          if (!accountMatches) this.fail('checkout_account_unverified');
        }
        const stripeConfirmation = stripe
          ? /^\/v1\/payment_pages\/(cs_[A-Za-z0-9_]+)\/confirm$/.exec(url.pathname)
          : null;
        if (stripeConfirmation) accountMatches = stripeConfirmation[1] === this.expected.checkoutId;
        let confirmation = false;
        if (
          request.method === 'POST' &&
          (stripeConfirmation ||
            (official &&
              [
                '/backend-api/payments/checkout/confirm',
                '/backend-api/subscriptions/update'
              ].includes(url.pathname)))
        ) {
          this.confirmationRequests++;
          if (this.confirmationRequests > 1) this.fail('duplicate_payment_observed');
          if (!this.armed) this.fail('unexpected_payment_observed');
          if (!accountMatches) this.fail('payment_account_binding_changed');
          if (stripeConfirmation) {
            if (!this.expected.checkoutId || stripeConfirmation[1] !== this.expected.checkoutId)
              this.fail('payment_order_binding_changed');
          } else if (url.pathname === '/backend-api/payments/checkout/confirm') {
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
              typeof (stripeConfirmation?.[1] ?? data.checkout_session_id) === 'string' &&
              /^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(
                String(stripeConfirmation?.[1] ?? data.checkout_session_id)
              )
            )
              observed.checkout_identifier = stripeConfirmation?.[1] ?? data.checkout_session_id;
            const pending = this.onUnexpected(observed).catch(() =>
              this.fail('unexpected_payment_persistence_failed')
            );
            this.pending.add(pending);
            void pending.finally(() => this.pending.delete(pending));
          }
        }
        const stripeId = stripe ? stripeQuoteCheckout(url.pathname) : undefined;
        const stripeVersion = stripeId ? (this.stripeVersions.get(stripeId) ?? 0) + 1 : undefined;
        if (stripeId && stripeVersion) {
          this.stripeVersions.set(stripeId, stripeVersion);
          this.stripeQuotes.delete(stripeId);
        }
        const nativeBilling =
          official &&
          this.nativeBinding &&
          [
            '/backend-api/payments/checkout/taxes',
            '/backend-api/payments/checkout/update_tax_id'
          ].includes(url.pathname)
            ? this.beginNativeBilling(url.pathname, String(request.method), data, nativeAuth, key, {
                state: bodyState,
                requestId:
                  typeof params.requestId === 'string' && params.requestId.length <= 256
                    ? params.requestId
                    : undefined,
                session
              })
            : undefined;
        // Native requests can contain tax IDs. Keep only their explicit billing projection.
        if (nativeBilling) data = {};
        this.request.set(key, {
          path: url.pathname,
          method: String(request.method),
          session,
          status: 0,
          data,
          confirmation,
          ...(official &&
          request.method === 'POST' &&
          url.pathname === '/backend-api/payments/checkout'
            ? { checkoutIndex: Math.min(this.checkoutRequests, 10) }
            : {}),
          stripeVersion,
          nativeBilling
        });
      }
      if (method === 'Network.responseReceived') {
        const item = this.request.get(key);
        if (item) {
          const response = paymentObject(params.response);
          item.status = Number(response.status);
          const headers = paymentObject(response.headers);
          const length = Object.entries(headers).find(
            ([key]) => key.toLowerCase() === 'content-length'
          )?.[1];
          if (
            Number(length) >
            (item.nativeBilling ? NATIVE_QUOTE_BODY_LIMIT : CHECKOUT_ERROR_BODY_LIMIT)
          )
            item.responseTooLarge = true;
        }
      }
      if (method === 'Network.loadingFailed') {
        const item = this.request.get(key);
        if (item?.path === '/backend-api/payments/checkout' && item.method === 'POST')
          this.checkoutFailure = { reason: 'official_checkout_network_failed' };
        if (item?.nativeBilling) {
          this.nativeBillingFailure(item.nativeBilling, 'native_billing_network_failed');
          if (!this.closed && item.nativeBilling.generation === this.nativeGeneration)
            this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
          this.nativeInflight.delete(item.nativeBilling.version);
        }
        this.request.delete(key);
      }
      if (method === 'Network.loadingFinished' && this.request.has(key)) {
        const item = this.request.get(key)!;
        if (
          Number(params.encodedDataLength) >
          (item.nativeBilling ? NATIVE_QUOTE_BODY_LIMIT : CHECKOUT_ERROR_BODY_LIMIT)
        )
          item.responseTooLarge = true;
        this.request.delete(key);
        const promise = this.read(String(params.requestId), item).catch(() => undefined);
        this.pending.add(promise);
        void promise.finally(() => this.pending.delete(promise));
      }
    });
  }
  trackNativeBilling(
    checkoutId: string,
    entity: string,
    plan: V2RechargePlan,
    lockedCurrency: string
  ) {
    if (
      this.closed ||
      !/^oaics_[A-Za-z0-9_]{1,200}$/.test(checkoutId) ||
      !/^[a-z][a-z0-9_]{0,40}$/.test(entity) ||
      !/^[A-Z]{3}$/.test(lockedCurrency)
    )
      throw new Error('native_billing_tracking_invalid');
    this.nativeBinding = {
      checkoutId,
      entity,
      plan,
      lockedCurrency,
      email: this.browser.identity.email
    };
    this.nativeGeneration++;
    this.clearNativeAuthentication();
    this.nativeVersion++;
    this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
    this.nativeObserved = false;
    this.nativeTaxesSequence = 0;
    this.nativeInflight.clear();
    this.nativeError = undefined;
    this.nativeAuthIssue = 'none';
    this.nativeBodyState = 'none';
    this.nativeRequestKind = 'none';
    this.nativeOrderState = 'missing';
    this.nativeBodiesRecovered = 0;
    this.nativeQuote = undefined;
    this.nativeBillingAnchor = undefined;
    this.nativeBillingAnchorWait = undefined;
    this.nativeQuoteVersion = 0;
  }
  nativeBilling(details: V2RechargeDetails): NativeBillingObservation {
    const result: NativeBillingObservation = {
      version: this.nativeVersion,
      pending: this.nativeInflight.size > 0,
      observed: this.nativeObserved,
      changedAt: this.nativeChangedAt
    };
    if (this.closed) return { ...result, error: 'native_billing_observer_closed' };
    if (this.nativeError) return { ...result, error: this.nativeError };
    if (!result.pending && this.nativeBinding && this.nativeQuote) {
      try {
        nativeBillingDetails(this.nativeQuote.request, details, this.nativeBinding);
        result.document = structuredClone(this.nativeQuote.document);
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'native_billing_details_invalid';
      }
    }
    return result;
  }
  assertNativeBillingVersion(version: number) {
    if (
      this.closed ||
      !this.nativeBinding ||
      version !== this.nativeVersion ||
      this.nativeInflight.size ||
      this.nativeError
    )
      throw new Error('native_billing_version_changed');
  }
  private beginNativeBilling(
    path: string,
    method: string,
    data: PaymentDocument,
    base: NativeAuthProof,
    key: string,
    body: NativeBodySource
  ) {
    const kind = path.endsWith('/taxes') ? 'taxes' : 'tax_id';
    this.nativeVersion++;
    this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
    this.nativeObserved = true;
    if (this.armed) this.fail('native_billing_changed_after_confirmation');
    if (kind === 'taxes') {
      this.nativeTaxesSequence++;
      this.nativeQuote = undefined;
      this.nativeError = undefined;
      this.nativeBillingAnchor = undefined;
      this.nativeBillingAnchorWait = undefined;
      this.nativeQuoteVersion = 0;
    }
    const wire = this.nativeWireEarly.get(key);
    this.nativeWireEarly.delete(key);
    const auth = resolvedNativeAuth(base, wire);
    const item: NativeRequestObservation = {
      bodyState: body.state,
      orderState: 'missing',
      generation: this.nativeGeneration,
      version: this.nativeVersion,
      sequence: this.nativeTaxesSequence,
      kind,
      authIssue: auth.issue,
      authExpiresAt: auth.expiresAt,
      authPending: base.recoverable && !wire,
      authFinalized: false,
      valid: false
    };
    if (item.authPending)
      item.authWait = new Promise<void>((resolve) => {
        item.releaseAuth = resolve;
      });
    this.nativeAuthRequests.set(key, { base, item, wire });
    if (this.nativeAuthRequests.size > 64) {
      const oldest = this.nativeAuthRequests.keys().next().value!;
      this.nativeAuthRequests.get(oldest)?.item.releaseAuth?.();
      this.nativeAuthRequests.delete(oldest);
      this.nativeBillingFailure(item, 'native_billing_observation_overflow');
      this.fail('native_billing_observation_overflow');
    }
    this.nativeAuthIssue = auth.issue;
    this.nativeBodyState = body.state;
    this.nativeRequestKind = kind;
    this.nativeInflight.add(item.version);
    try {
      if (auth.issue !== 'none' && !item.authPending)
        throw new Error('native_billing_account_mismatch');
      if (method !== 'POST') throw new Error('native_billing_method_invalid');
      if (body.state === 'invalid') throw new Error('native_billing_request_body_invalid');
      if (body.state === 'oversized') throw new Error('native_billing_request_body_oversized');
      const anchorWait = kind === 'tax_id' ? this.nativeBillingAnchorWait : undefined;
      if (body.state === 'omitted' || anchorWait)
        item.bodyWait = this.completeNativeBody(item, method, data, body, anchorWait);
      else this.acceptNativeBody(item, method, data);
      if (kind === 'taxes') this.nativeBillingAnchorWait = item.bodyWait;
    } catch (error) {
      this.nativeBillingFailure(
        item,
        error instanceof Error ? error.message : 'native_billing_request_invalid'
      );
    }
    return item;
  }
  private acceptNativeBody(item: NativeRequestObservation, method: string, data: PaymentDocument) {
    if (
      this.closed ||
      item.generation !== this.nativeGeneration ||
      item.sequence !== this.nativeTaxesSequence
    )
      return;
    try {
      item.orderState =
        typeof data.checkout_session_id !== 'string'
          ? 'missing'
          : data.checkout_session_id === this.nativeBinding!.checkoutId
            ? 'matches'
            : 'mismatch';
      if (item.version === this.nativeVersion) this.nativeOrderState = item.orderState;
      if (item.authIssue !== 'none' && !item.authPending)
        throw new Error('native_billing_account_mismatch');
      if (method !== 'POST') throw new Error('native_billing_method_invalid');
      if (item.kind === 'taxes') {
        item.billing = nativeBillingRequest(data, this.nativeBinding!);
        this.nativeBillingAnchor = item.billing;
      } else {
        if (data.checkout_session_id !== this.nativeBinding!.checkoutId)
          throw new Error('native_billing_request_order_mismatch');
        if (data.tax_id_info !== null) throw new Error('native_billing_tax_context_unverified');
        if (!this.nativeBillingAnchor) throw new Error('native_billing_tax_context_unverified');
        item.billing = this.nativeBillingAnchor;
      }
      item.valid = true;
      if (item.version === this.nativeVersion) this.nativeBodyState = item.bodyState;
    } catch (error) {
      this.nativeBillingFailure(
        item,
        error instanceof Error ? error.message : 'native_billing_request_invalid'
      );
    }
  }
  private async completeNativeBody(
    item: NativeRequestObservation,
    method: string,
    supplied: PaymentDocument,
    source: NativeBodySource,
    anchorWait?: Promise<void>
  ) {
    try {
      let data = supplied;
      if (source.state === 'omitted') {
        if (!source.requestId) throw new Error('native_billing_request_body_missing');
        if (!this.ownsSession(source.session)) throw new Error('native_billing_session_changed');
        const raw = await this.browser.cdp
          .command(
            'Network.getRequestPostData',
            { requestId: source.requestId },
            source.session,
            3000
          )
          .catch(() => {
            item.bodyState = 'unavailable';
            throw new Error('native_billing_request_body_unavailable');
          });
        if (
          this.closed ||
          item.generation !== this.nativeGeneration ||
          item.sequence !== this.nativeTaxesSequence
        )
          return;
        if (!this.ownsSession(source.session)) throw new Error('native_billing_session_changed');
        if (raw.base64Encoded) {
          item.bodyState = 'encoded';
          throw new Error('native_billing_request_body_encoded');
        }
        if (typeof raw.postData !== 'string' || !raw.postData) {
          item.bodyState = 'missing';
          throw new Error('native_billing_request_body_missing');
        }
        if (raw.postData.length > NATIVE_POST_DATA_LIMIT) {
          item.bodyState = 'oversized';
          throw new Error('native_billing_request_body_oversized');
        }
        try {
          data = paymentObject(JSON.parse(raw.postData));
        } catch {
          item.bodyState = 'invalid';
          throw new Error('native_billing_request_body_invalid');
        }
        item.bodyState = 'retrieved';
        this.nativeBodiesRecovered++;
      }
      if (anchorWait) await anchorWait;
      this.acceptNativeBody(item, method, data);
    } catch (error) {
      this.nativeBillingFailure(
        item,
        error instanceof Error ? error.message : 'native_billing_request_body_unavailable'
      );
    }
  }
  private clearNativeAuthentication() {
    for (const { item } of this.nativeAuthRequests.values()) item.releaseAuth?.();
    this.nativeAuthRequests.clear();
    this.nativeWireEarly.clear();
  }
  private applyNativeWire(
    tracked: { base: NativeAuthProof; item: NativeRequestObservation; wire?: NativeAuthProof },
    wire: NativeAuthProof
  ) {
    const { item, base } = tracked;
    if (item.generation !== this.nativeGeneration || item.sequence !== this.nativeTaxesSequence)
      return;
    tracked.wire = combinedNativeWire(tracked.wire, wire);
    const proof = resolvedNativeAuth(base, tracked.wire);
    // Expired waits and failed reads cannot be resurrected by a late event.
    if (item.authFinalized && item.authIssue !== 'none' && proof.issue === 'none') return;
    const invalidatesQuote =
      !item.authPending && item.authIssue === 'none' && proof.issue !== 'none';
    item.authIssue = proof.issue;
    item.authExpiresAt = proof.expiresAt;
    item.authPending = false;
    item.releaseAuth?.();
    item.releaseAuth = undefined;
    item.authWait = undefined;
    if (item.version === this.nativeVersion) this.nativeAuthIssue = proof.issue;
    if (proof.issue !== 'none') {
      this.nativeBillingFailure(item, 'native_billing_account_mismatch');
      if (invalidatesQuote) {
        this.nativeVersion++;
        this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
        if (this.armed) this.fail('native_billing_changed_after_confirmation');
      }
    }
  }
  private nativeBillingFailure(item: NativeRequestObservation, reason: string) {
    if (
      this.closed ||
      item.generation !== this.nativeGeneration ||
      item.sequence !== this.nativeTaxesSequence
    )
      return;
    this.nativeAuthIssue = item.authIssue;
    this.nativeBodyState = item.bodyState;
    this.nativeRequestKind = item.kind;
    this.nativeOrderState = item.orderState;
    this.nativeError = /^native_billing_[a-z_]+$/.test(reason)
      ? reason
      : 'native_billing_response_invalid';
  }
  private async readNativeBilling(
    requestId: string,
    item: {
      session: string;
      status: number;
      responseTooLarge?: boolean;
      nativeBilling: NativeRequestObservation;
    }
  ) {
    const native = item.nativeBilling;
    try {
      if (
        this.closed ||
        native.generation !== this.nativeGeneration ||
        native.sequence !== this.nativeTaxesSequence
      )
        return;
      if (!this.ownsSession(item.session)) throw new Error('native_billing_session_changed');
      if (native.bodyWait) await native.bodyWait;
      if (
        this.closed ||
        native.generation !== this.nativeGeneration ||
        native.sequence !== this.nativeTaxesSequence
      )
        return;
      if (!this.ownsSession(item.session)) throw new Error('native_billing_session_changed');
      if (!native.valid) return;
      if (native.authPending && native.authWait) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            native.authWait,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            })
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          native.authPending = false;
          native.releaseAuth = undefined;
          native.authWait = undefined;
        }
      }
      native.authFinalized = true;
      if (
        this.closed ||
        native.generation !== this.nativeGeneration ||
        native.sequence !== this.nativeTaxesSequence
      )
        return;
      if (native.authIssue !== 'none' || native.authExpiresAt <= Date.now()) {
        if (native.authIssue === 'none') native.authIssue = 'token_expired_or_missing';
        throw new Error('native_billing_account_mismatch');
      }
      if (item.status < 200 || item.status >= 300) throw new Error('native_billing_http_failed');
      if (item.responseTooLarge) throw new Error('native_billing_response_oversized');
      const body = await this.browser.cdp
        .command('Network.getResponseBody', { requestId }, item.session, 3000)
        .catch(() => {
          throw new Error('native_billing_body_unavailable');
        });
      if (
        this.closed ||
        native.generation !== this.nativeGeneration ||
        native.sequence !== this.nativeTaxesSequence
      )
        return;
      if (!this.ownsSession(item.session)) throw new Error('native_billing_session_changed');
      if (typeof body.body === 'string' && body.body.length > NATIVE_QUOTE_BODY_LIMIT)
        throw new Error('native_billing_response_oversized');
      if (typeof body.body !== 'string') throw new Error('native_billing_body_missing');
      if (body.base64Encoded) throw new Error('native_billing_body_base64');
      let raw: unknown;
      try {
        raw = JSON.parse(body.body);
      } catch {
        throw new Error('native_billing_body_json_invalid');
      }
      const document = nativeQuoteDocument(raw, native.billing!, this.nativeBinding!, native.kind);
      if (native.version >= this.nativeQuoteVersion) {
        this.nativeQuote = { request: native.billing!, document };
        this.nativeQuoteVersion = native.version;
      }
    } catch (error) {
      this.nativeBillingFailure(
        native,
        error instanceof Error ? error.message : 'native_billing_response_unavailable'
      );
    } finally {
      if (!this.closed && native.generation === this.nativeGeneration)
        this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
      this.nativeInflight.delete(native.version);
    }
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
      checkoutIndex?: number;
      responseTooLarge?: boolean;
      stripeVersion?: number;
      nativeBilling?: NativeRequestObservation;
    }
  ) {
    if (item.nativeBilling) {
      await this.readNativeBilling(requestId, { ...item, nativeBilling: item.nativeBilling });
      return;
    }
    const checkout = item.path === '/backend-api/payments/checkout' && item.method === 'POST';
    if (checkout && (item.status < 200 || item.status >= 300)) {
      const failure: NonNullable<DirectPaymentObserver['checkoutFailure']> = {
        reason: 'official_checkout_http_failed',
        ...(Number.isInteger(item.status) && item.status >= 100 && item.status <= 599
          ? { http_status: item.status }
          : {}),
        diagnostics: {
          checkout_error: {
            request_index: item.checkoutIndex,
            body_state: 'reading',
            attribution: 'unclassified'
          } as V2CheckoutDiagnostic
        }
      };
      this.checkoutFailure = failure;
      // Keep the observed HTTP failure even when the bounded body read fails or the page detaches.
      let diagnostic: V2CheckoutDiagnostic;
      if (this.closed || !this.ownsSession(item.session)) diagnostic = { body_state: 'detached' };
      else if (item.responseTooLarge) diagnostic = { body_state: 'oversized' };
      else {
        try {
          const body = await this.browser.cdp.command(
            'Network.getResponseBody',
            { requestId },
            item.session,
            3000
          );
          diagnostic =
            this.closed || !this.ownsSession(item.session)
              ? { body_state: 'detached' }
              : checkoutErrorDiagnostic(body);
        } catch {
          diagnostic = { body_state: 'unavailable' };
        }
      }
      // An older response cannot overwrite a later failure (no request is retried here).
      if (this.checkoutFailure === failure)
        failure.diagnostics!.checkout_error = {
          request_index: item.checkoutIndex,
          attribution: 'unclassified',
          ...diagnostic
        };
      return;
    }
    const body = await this.browser.cdp.command(
      'Network.getResponseBody',
      { requestId },
      item.session
    );
    if (this.closed || !this.ownsSession(item.session)) return;
    let raw: PaymentDocument;
    try {
      if (typeof body.body !== 'string' || body.body.length > 100000 || body.base64Encoded)
        throw new Error();
      raw = paymentObject(JSON.parse(body.body));
    } catch {
      if (checkout) this.checkoutFailure = { reason: 'official_checkout_response_invalid' };
      return;
    }
    if (item.status < 200 || item.status >= 300) return;
    const stripeId = stripeQuoteCheckout(item.path);
    if (stripeId) {
      if (item.stripeVersion !== this.stripeVersions.get(stripeId)) return;
      const quote = stripeQuoteDocument(raw, stripeId);
      if (quote) this.stripeQuotes.set(stripeId, quote);
      return;
    }
    if (checkout) {
      const value = paymentObject(raw.checkout_session ?? raw);
      if (
        !this.failure &&
        /^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(
          String(value.checkout_session_id ?? value.session_id)
        )
      )
        this.checkout = value;
      else if (!this.failure)
        this.checkoutFailure = { reason: 'official_checkout_response_invalid' };
    }
    if (item.path === '/backend-api/subscriptions/update/preview') this.preview = raw;
    if (
      item.path === '/backend-api/payments/checkout/confirm' ||
      item.path === '/backend-api/subscriptions/update' ||
      /^\/v1\/payment_pages\/cs_[A-Za-z0-9_]+\/confirm$/.test(item.path)
    ) {
      if (!item.confirmation || this.failure) return;
      if (
        (raw.checkout_session_id !== undefined &&
          raw.checkout_session_id !== this.expected.checkoutId) ||
        (raw.session_id !== undefined && raw.session_id !== this.expected.checkoutId)
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
    if (this.nativeBinding && !this.closed)
      console.info(
        '[bitbrowser-native-quote]',
        JSON.stringify({
          observed: this.nativeObserved,
          pending: this.nativeInflight.size > 0,
          quoteReady: Boolean(this.nativeQuote),
          taxesObserved: this.nativeTaxesSequence > 0,
          authIssue: this.nativeAuthIssue,
          bodyState: this.nativeBodyState,
          bodyRecovered: this.nativeBodiesRecovered > 0,
          requestKind: this.nativeRequestKind,
          orderState: this.nativeOrderState,
          reason: this.nativeError ?? 'none'
        })
      );
    this.closed = true;
    this.remove();
    this.request.clear();
    this.clearNativeAuthentication();
    this.stripeQuotes.clear();
    this.stripeVersions.clear();
    this.receipts = [];
    this.nativeBinding = undefined;
    this.nativeQuote = undefined;
    this.nativeBillingAnchor = undefined;
    this.nativeBillingAnchorWait = undefined;
    this.nativeQuoteVersion = 0;
    this.nativeInflight.clear();
    this.nativeError = undefined;
    this.nativeObserved = false;
    this.nativeVersion++;
    this.nativeChangedAt = Math.max(Date.now(), this.nativeChangedAt + 1);
  }
}
