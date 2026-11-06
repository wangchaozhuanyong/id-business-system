import { shallowReactive } from 'vue';
import type { V2RechargeBrowserRestore } from '@apple-business/shared';
import type {
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserRecheckLaunch,
  V2RechargeDetails,
  V2RechargePlan
} from './contracts';
import { rechargeApi } from './api';
import { runDirectLogin, type DirectLoginCode } from './bitbrowser-direct-login';
import type { DirectLoginCredential } from './bitbrowser-direct-credential';
import { automaticLoginCode } from './recharge-login-code';
import { directOperationDeadline } from './recharge-direct-lifecycle';
import { clearDirectCheckoutBinding, runDirectPayment } from './bitbrowser-direct-payment';
import { runDirectPaymentRecheck } from './bitbrowser-direct-recheck';
import { paymentObject, type PaymentDocument } from './bitbrowser-payment-evidence';
import { DirectBrowserError } from './bitbrowser-direct-api';
import {
  DirectPaymentDiagnosticError,
  directPaymentOperation
} from './bitbrowser-payment-diagnostics';

interface PaymentControl {
  id: string;
  digest: string;
  expiresAt: string;
  pending: boolean;
  confirming: boolean;
  message: string;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
  code?: (code: DirectLoginCode) => void;
}
function paymentError(cause: unknown) {
  if (cause instanceof DirectPaymentDiagnosticError) return cause.message;
  if (cause instanceof DirectBrowserError) return cause.message;
  const internal = cause instanceof Error ? cause.message : '';
  const known: Record<string, string> = {
    payment_form_changed: '银行卡资料已变化，请重新核对。',
    billing_fields_changed: '账单资料已变化，请重新核对。',
    official_payment_field_not_ready: '官网付款字段尚未就绪，请检查原窗口。',
    ambiguous_official_payment_field: '官网付款字段不唯一，本次已停止。',
    invalid_payment_field: '官网付款字段校验未通过，请检查原窗口。',
    bitbrowser_direct_cancelled: '本次网页充值已停止。'
  };
  if (known[internal]) return known[internal];
  if (/过期/.test(internal)) return '本次官网原单或报价确认已过期，请核对原任务。';
  if (/报价|核价|计税|币种/.test(internal))
    return '官网报价或账单资料尚未核实，请核对原窗口后重新核价。';
  if (/原单|历史|升级|订阅/.test(internal))
    return '原单或订阅状态尚未核实，请查看原窗口与执行记录。';
  if (/银行卡|账单|付款方式|字段/.test(internal))
    return '官网银行卡或账单资料未核实，请检查原窗口。';
  if (/已停止/.test(internal)) return '本次网页充值已停止。';
  return '网页充值执行未完成，请检查原窗口和原单记录。';
}
/** Page-memory controls only. No credentials or confirmation nonce enter drafts or storage. */
export const directPaymentControls = shallowReactive(new Map<string, PaymentControl>());
export const ownsDirectPayment = (id: string) => directPaymentControls.has(id);
export function submitDirectPaymentCode(id: string, code: DirectLoginCode) {
  const request = directPaymentControls.get(id)?.code;
  if (!request) throw new Error('本次网页充值未在等待验证码，请检查原窗口。');
  request(code);
}
export async function cancelDirectPayment(id: string) {
  const control = directPaymentControls.get(id);
  if (control) await control.cancel();
  else await rechargeApi.cancelBitBrowser(id);
}

export async function startDirectPayment(input: {
  launch: V2RechargeBitBrowserLaunch | V2RechargeBitBrowserRecheckLaunch;
  plan: V2RechargePlan;
  credential: DirectLoginCredential;
  recheck?: PaymentDocument;
  payment: V2RechargeDetails;
  windowName: string;
  accountId?: string;
  signal: AbortSignal;
  refresh: () => Promise<unknown>;
  reportError: (message: string) => void;
}) {
  const { launch, credential, payment, plan } = input;
  if (directPaymentControls.size) throw new Error('当前网页已有充值任务，请先处理原任务。');
  const controller = new AbortController();
  let attempted = false;
  let authorizationUncertain = false;
  let unexpectedObserved = false;
  let done = Promise.resolve();
  let nonce = '';
  let preflight: (() => Promise<void>) | undefined;
  let approve: (() => void) | undefined;
  let rejectApproval: ((error: unknown) => void) | undefined;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let lastReport: PaymentDocument = {
    transport: 'web_direct',
    mode: 'payment',
    payment_attempted: false,
    payment_requests_sent: 0
  };
  let restored: V2RechargeBrowserRestore | undefined;
  const setControl = (patch: Partial<PaymentControl>) => {
    const current = directPaymentControls.get(launch.id);
    if (current) directPaymentControls.set(launch.id, { ...current, ...patch });
  };
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  globalThis.addEventListener?.('pagehide', abort, { once: true });
  if (input.signal.aborted) controller.abort();
  const callback = async (body: object, final = false) => {
    const value = await directOperationDeadline(
      (signal) => rechargeApi.directBrowserCallback(launch.id, launch.agentToken, body, { signal }),
      15000,
      final ? undefined : controller.signal
    );
    return value as unknown as PaymentDocument;
  };
  const progress = async (stage: string, result: PaymentDocument = {}) => {
    if (
      !input.recheck &&
      (result.payment_attempted === true || Number(result.payment_requests_sent) > 0)
    )
      attempted = true;
    lastReport = {
      ...lastReport,
      ...result,
      transport: 'web_direct',
      mode: input.recheck ? 'recheck' : 'payment',
      stage,
      ...(input.recheck
        ? {
            recheck_only: true,
            payment_attempted: true,
            payment_requests_sent: 0,
            confirmation_requests_sent: 0
          }
        : {})
    };
    await callback({ type: 'progress', result: { ...lastReport, status: 'running' } });
    void input.refresh();
  };
  const control: PaymentControl = {
    id: launch.id,
    digest: '',
    expiresAt: '',
    pending: false,
    confirming: false,
    message: '',
    async confirm() {
      const current = directPaymentControls.get(launch.id);
      if (
        !current?.pending ||
        current.confirming ||
        !nonce ||
        !preflight ||
        attempted ||
        authorizationUncertain ||
        !(Date.parse(current.expiresAt) > Date.now())
      )
        return;
      setControl({ confirming: true, message: '' });
      try {
        await preflight();
        controller.signal.throwIfAborted();
        if (Date.parse(current.expiresAt) <= Date.now())
          throw new Error('本次报价确认已过期，请重新核价。');
        const singleNonce = nonce;
        nonce = '';
        // Treat an ambiguous authorization response as reserved: it must never cause a retry click.
        authorizationUncertain = true;
        const identifier = String(
          lastReport.upgrade_identifier ?? lastReport.checkout_identifier ?? ''
        );
        if (!/^(?:oaics|cs|upg)_[A-Za-z0-9_]{1,200}$/.test(identifier))
          throw new Error('官网原单编号未核实，本次未提交付款。');
        const grant = await directOperationDeadline(
          (signal) =>
            rechargeApi.confirmDirectPayment(
              launch.id,
              {
                nonce: singleNonce,
                quoteDigest: current.digest,
                checkoutIdentifier: identifier
              },
              { signal }
            ),
          15000,
          controller.signal
        );
        if (grant.paymentAllowed !== true || grant.id !== launch.id)
          throw new Error('单次付款授权结果待核实，本次不会提交或重发。');
        attempted = true;
        lastReport = { ...lastReport, payment_attempted: true, payment_status: 'unknown' };
        setControl({ pending: false });
        approve?.();
        approve = undefined;
        rejectApproval = undefined;
      } catch (cause) {
        const message = paymentError(cause);
        setControl({ pending: false, message });
        rejectApproval?.(
          cause instanceof DirectPaymentDiagnosticError ? cause : new Error(message)
        );
        rejectApproval = undefined;
        approve = undefined;
        input.reportError(message);
      } finally {
        setControl({ confirming: false });
        void input.refresh();
      }
    },
    async cancel() {
      if (attempted || authorizationUncertain)
        throw new Error('本次付款授权结果需核实原单，不得重新提交。');
      controller.abort();
      rejectApproval?.(new Error('本次网页充值已停止。'));
      await done;
    }
  };
  directPaymentControls.set(launch.id, control);
  let accepted!: () => void;
  let rejected!: (cause: unknown) => void;
  const started = new Promise<void>((resolve, reject) => {
    accepted = resolve;
    rejected = reject;
  });
  done = (async () => {
    let acknowledged = false;
    try {
      await progress('bitbrowser_group');
      acknowledged = true;
      accepted();
      const result = await runDirectLogin(
        launch.bitBrowser,
        credential,
        input.windowName,
        controller.signal,
        {
          ownedProfile: 'ownedProfile' in launch ? launch.ownedProfile : undefined,
          progress,
          restore: async (accountKey) => {
            restored = (await directPaymentOperation('existing_checkout_binding', () =>
              callback({
                type: 'restore',
                accountKey,
                ...('subscriptionCycleProtocol' in launch && launch.subscriptionCycleProtocol
                  ? { subscriptionCycleProtocol: launch.subscriptionCycleProtocol }
                  : {})
              })
            )) as unknown as V2RechargeBrowserRestore;
            return restored;
          },
          code: (challenge) =>
            input.accountId
              ? automaticLoginCode(launch.id, input.accountId, challenge, controller.signal)
              : new Promise<DirectLoginCode>((resolve, reject) => {
                  const aborted = () => {
                    setControl({ code: undefined });
                    reject(new Error('本次验证码输入已停止。'));
                  };
                  controller.signal.addEventListener('abort', aborted, { once: true });
                  setControl({
                    code: (value) => {
                      controller.signal.removeEventListener('abort', aborted);
                      setControl({ code: undefined });
                      resolve(value);
                    }
                  });
                }),
          ready: async (browser) => {
            const remove = browser.cdp.onClose(() => controller.abort());
            try {
              if (input.recheck) {
                const source = input.recheck;
                await progress('original_payment_recheck', { recheck_only: true });
                return await directPaymentOperation('recheck', () =>
                  runDirectPaymentRecheck(browser, plan, source, restored, callback)
                );
              }
              return await runDirectPayment(
                browser,
                launch as V2RechargeBitBrowserLaunch,
                plan,
                payment,
                {
                  restored,
                  callback,
                  progress,
                  checkoutAttempted: () => {
                    lastReport = clearDirectCheckoutBinding(lastReport);
                  },
                  attempted: () => attempted,
                  unexpected: async (report) => {
                    unexpectedObserved = true;
                    attempted = true;
                    lastReport = {
                      ...lastReport,
                      ...report,
                      payment_attempted: true,
                      payment_status: 'unknown'
                    };
                    rejectApproval?.(
                      new Error('原窗口已观察到付款操作，本次确认已停止，请只读核实原单。')
                    );
                    nonce = '';
                    setControl({ pending: false });
                    const result: PaymentDocument = {
                      account_matched: true,
                      current_plan_before: report.current_plan_before,
                      target_plan: plan,
                      payment_requests_sent: report.payment_requests_sent,
                      confirmation_requests_sent: report.confirmation_requests_sent,
                      ...(report.upgrade_identifier
                        ? { upgrade_identifier: report.upgrade_identifier }
                        : { checkout_identifier: report.checkout_identifier }),
                      ...(report.processor_entity
                        ? { processor_entity: report.processor_entity }
                        : {})
                    };
                    const receipt = await callback(
                      { type: 'direct_unexpected_payment', result },
                      true
                    );
                    if (receipt.paymentLocked !== true)
                      throw new Error('官网付款观察记录待核实，请保留原任务。');
                  },
                  confirm: async (report, verify) => {
                    lastReport = { ...lastReport, ...report };
                    const confirmation = paymentObject(
                      await callback({ type: 'direct_quote', result: lastReport })
                    );
                    if (
                      typeof confirmation.nonce !== 'string' ||
                      !confirmation.nonce ||
                      typeof confirmation.quote_digest !== 'string' ||
                      typeof confirmation.confirmation_expires_at !== 'string' ||
                      !(Date.parse(confirmation.confirmation_expires_at) > Date.now())
                    )
                      throw new Error('官网报价确认凭据未核实。');
                    nonce = confirmation.nonce;
                    preflight = verify;
                    setControl({
                      digest: confirmation.quote_digest,
                      expiresAt: confirmation.confirmation_expires_at,
                      pending: true
                    });
                    void input.refresh();
                    await new Promise<void>((resolve, reject) => {
                      approve = resolve;
                      rejectApproval = reject;
                      const abortWaiting = () => reject(new Error('本次网页充值已停止。'));
                      controller.signal.addEventListener('abort', abortWaiting, { once: true });
                      confirmationTimer = setTimeout(
                        () => {
                          nonce = '';
                          setControl({
                            pending: false,
                            message: '本次报价确认已过期，请重新核价。'
                          });
                          controller.signal.removeEventListener('abort', abortWaiting);
                          reject(new Error('本次报价确认已过期，请重新核价。'));
                        },
                        Math.max(
                          1,
                          Date.parse(confirmation.confirmation_expires_at as string) - Date.now()
                        )
                      );
                    });
                    clearTimeout(confirmationTimer);
                  }
                }
              );
            } finally {
              remove();
            }
          }
        }
      );
      lastReport = { ...lastReport, ...result };
      await callback({ type: 'finished', result: lastReport }, true);
      ended = true;
    } catch (cause) {
      if (!acknowledged) rejected(cause);
      const message = paymentError(cause);
      const cancelled = controller.signal.aborted && !attempted && !authorizationUncertain;
      if (!input.signal.aborted && !cancelled) input.reportError(message);
      if (!ended) {
        const diagnostic =
          cause instanceof DirectPaymentDiagnosticError
            ? cause.facts
            : cause instanceof DirectBrowserError
              ? { reason: cause.reason }
              : undefined;
        await callback(
          {
            type: 'finished',
            result: {
              ...lastReport,
              ...diagnostic,
              status:
                attempted || authorizationUncertain
                  ? 'payment_result_unknown'
                  : cancelled
                    ? 'cancelled'
                    : 'blocked',
              reason:
                attempted || authorizationUncertain
                  ? 'payment_result_unknown'
                  : cancelled
                    ? 'operation_cancelled'
                    : (diagnostic?.reason ?? 'direct_payment_preparation_failed'),
              ...(diagnostic && (attempted || authorizationUncertain)
                ? { last_reason: diagnostic.reason }
                : {}),
              payment_attempted: input.recheck ? true : attempted,
              payment_status: input.recheck || attempted ? 'unknown' : 'not_attempted',
              ...(cancelled ? { cancellation_confirmed: true } : {})
            }
          },
          true
        ).catch(() => {
          if (!unexpectedObserved)
            void rechargeApi.cancelBitBrowser(launch.id).catch(() => undefined);
        });
      }
    } finally {
      clearTimeout(confirmationTimer);
      nonce = '';
      preflight = undefined;
      approve = undefined;
      rejectApproval = undefined;
      input.signal.removeEventListener('abort', abort);
      globalThis.removeEventListener?.('pagehide', abort);
      for (const key of Object.keys(payment) as (keyof V2RechargeDetails)[]) payment[key] = '';
      launch.agentToken = '';
      launch.bitBrowser.localApiToken = '';
      launch.bitBrowser.dynamicProxyUrl = '';
      if ('savedLogin' in launch && launch.savedLogin) launch.savedLogin.password = '';
      if (launch.bitBrowser.staticProxyCredentials)
        launch.bitBrowser.staticProxyCredentials.password = '';
      directPaymentControls.delete(launch.id);
      void input.refresh();
    }
  })();
  return started;
}
