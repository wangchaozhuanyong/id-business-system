import { onScopeDispose, watch, type Ref } from 'vue';
import { V2_RECHARGE_SUBSCRIPTION_CYCLE_CAPABILITY } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import { rechargeApi, rechargeCallbackUrl, rechargeConnectorApi } from './api';
import { bankRechargeApi } from './bank-recharge-api';
import type { DirectLoginCredential } from './bitbrowser-direct-credential';
import type { ConnectorStatus } from './useRechargeBrowserSettings';
import { directOperationDeadline } from './recharge-direct-lifecycle';
import type {
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserStart,
  V2RechargeDetails
} from './contracts';

interface PaymentStartContext {
  canStart: Ref<boolean>;
  busy: Ref<boolean>;
  error: Ref<string>;
  currentId: Ref<string>;
  connectorStatus: Ref<ConnectorStatus>;
  connectorMessage: Ref<string>;
  localAccess: Ref<{ connectorUrl: string; connectorToken: string } | null>;
  snapshot: () =>
    | {
        input: Omit<V2RechargeBitBrowserStart, 'id' | 'subscriptionCycleProtocol'>;
        payment: Pick<V2RechargeDetails, 'number' | 'expiry' | 'cvc' | 'name' | 'email'>;
        credential: DirectLoginCredential;
        connectionVersion: string;
      }
    | undefined;
  apiProtocol: () => number | undefined;
  connectionVersion: () => string;
  editVersion: () => number;
  verifiedDetails: () => { name: string; addressId: string; cardId: string } | undefined;
  ensureNameReady: () => Promise<void>;
  checkSavedConnection: (current: () => boolean) => Promise<string[]>;
  beginPaymentSave: (id: string) => () => void;
  refresh: () => Promise<unknown>;
}

export function useRechargePaymentStart(context: PaymentStartContext) {
  let generation = 0;
  let disposed = false;
  let pending = false;
  let clearPending: (() => void) | undefined;
  watch(
    sessionCoordinator.identityEpoch,
    () => {
      generation++;
      clearPending?.();
      clearPending = undefined;
      if (pending) context.busy.value = false;
      pending = false;
    },
    { flush: 'sync' }
  );
  onScopeDispose(() => {
    disposed = true;
    generation++;
    clearPending?.();
    clearPending = undefined;
  });
  async function start() {
    if (disposed || !context.canStart.value) return;
    const snapshot = context.snapshot();
    if (!snapshot) return;
    const epoch = sessionCoordinator.identityEpoch.value;
    const revision = ++generation;
    const editRevision = context.editVersion();
    const current = () =>
      !disposed && revision === generation && epoch === sessionCoordinator.identityEpoch.value;
    const id = crypto.randomUUID();
    const { input, payment, credential } = snapshot;
    let resolvedCredential: DirectLoginCredential | undefined;
    const checkConnectionSnapshot = () => {
      if (editRevision !== context.editVersion())
        throw new Error('充值资料在核实期间已变化，请核对当前资料后重试；本次未提交任务或付款。');
      if (snapshot.connectionVersion !== context.connectionVersion())
        throw new Error('连接配置已变化，请核对原电脑配置后重新开始；本次未发送付款确认。');
    };
    const clear = () => {
      payment.cvc = '';
      payment.number = '';
      if (credential.login) credential.login.password = '';
      if ('sessionJson' in credential) credential.sessionJson = '';
      if (resolvedCredential?.login) resolvedCredential.login.password = '';
    };
    clearPending = clear;
    context.busy.value = true;
    context.error.value = '';
    pending = true;
    let launch: V2RechargeBitBrowserLaunch | null = null;
    let dispatched = false;
    async function releaseUnreceived() {
      if (!launch) return;
      if (epoch === sessionCoordinator.identityEpoch.value)
        await rechargeApi.abandonUnreceivedBitBrowser(id);
      else
        await directOperationDeadline(
          (signal) =>
            rechargeApi.directBrowserCallback(
              id,
              launch!.agentToken,
              {
                type: 'finished',
                result: {
                  status: 'cancelled',
                  stage: 'connector_dispatch',
                  cancellation_confirmed: true,
                  payment_attempted: false,
                  payment_requests_sent: 0
                }
              },
              { signal }
            ),
          15_000
        );
    }
    try {
      await context.ensureNameReady();
      if (!current()) return;
      checkConnectionSnapshot();
      const verified = context.verifiedDetails();
      if (!verified) throw new Error('银行卡或账单地址核实未完成，请核对后重试。');
      // 只吸收这次匹配已应用的姓名和自动地址；账号、套餐、币种与连接仍使用点击时绑定。
      payment.name = verified.name;
      input.billingName = verified.name;
      input.addressId = verified.addressId;
      const rememberPaymentSave = context.beginPaymentSave(id);
      await bankRechargeApi.checkCardAvailability(payment.number);
      if (!current()) return;
      checkConnectionSnapshot();
      const capabilities = await context.checkSavedConnection(current);
      if (!current()) return;
      checkConnectionSnapshot();
      const paymentCard = await bankRechargeApi.preparePaymentCard({
        number: payment.number,
        expiry: payment.expiry,
        name: payment.name,
        currencyCode: input.lockedCurrency
      });
      if (!current()) return;
      checkConnectionSnapshot();
      const negotiated =
        context.apiProtocol() === 1 &&
        capabilities.includes(V2_RECHARGE_SUBSCRIPTION_CYCLE_CAPABILITY);
      launch = await rechargeApi.startBitBrowser({
        ...input,
        id,
        cardId: paymentCard.cardId,
        ...(negotiated ? { subscriptionCycleProtocol: 1 as const } : {})
      });
      if (!current()) {
        await releaseUnreceived().catch(() => undefined);
        return;
      }
      checkConnectionSnapshot();
      context.currentId.value = id;
      rememberPaymentSave();
      context.localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      if (input.useSavedCredentials && input.chatgptAccountId) {
        const saved =
          launch.savedLogin ?? (await bankRechargeApi.loginCredential(input.chatgptAccountId));
        resolvedCredential = { login: { email: saved.email, password: saved.password } };
      } else resolvedCredential = credential;
      if (!current()) {
        await releaseUnreceived().catch(() => undefined);
        return;
      }
      checkConnectionSnapshot();
      dispatched = true;
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id,
        mode: launch.mode,
        plan: input.plan,
        windowName: input.windowName,
        ...resolvedCredential,
        details: { ...payment },
        address: launch.address,
        bitBrowser: launch.bitBrowser,
        safety: {
          lockedCurrency: launch.safety.lockedCurrency,
          authorizeSinglePayment: launch.safety.authorizeSinglePayment,
          manualPaymentConfirmation: launch.safety.manualPaymentConfirmation
        },
        ...(launch.ownedProfile ? { ownedProfile: launch.ownedProfile } : {}),
        ...(negotiated && launch.subscriptionCycleProtocol === 1
          ? { subscriptionCycleProtocol: 1 }
          : {}),
        callbackUrl: rechargeCallbackUrl(id),
        agentToken: launch.agentToken,
        authorizeSinglePayment: true
      });
      if (!current()) return;
      context.connectorStatus.value = 'online';
      context.connectorMessage.value = '本机连接器已接收任务';
    } catch (cause) {
      if (!current()) {
        if (launch && !dispatched) await releaseUnreceived().catch(() => undefined);
        return;
      }
      if (launch) {
        if (!dispatched) {
          context.error.value = getApiErrorMessage(cause);
          try {
            await releaseUnreceived();
            if (current()) context.error.value += ' 原任务已安全结束，资料已保留。';
          } catch {
            if (current()) context.error.value += ' 原任务结束结果待核对，请刷新原任务。';
          }
          return;
        }
        try {
          await rechargeConnectorApi.status(launch.connectorUrl, launch.connectorToken, id);
          if (!current()) return;
          context.connectorStatus.value = 'online';
          context.connectorMessage.value = '本机连接器已接收，本次不会重发';
          context.error.value = '';
        } catch {
          if (!current()) return;
          try {
            await rechargeApi.abandonUnreceivedBitBrowser(id);
            if (!current()) return;
            context.connectorStatus.value = 'offline';
            context.connectorMessage.value = '本机连接器未接收';
            context.error.value = '本机连接器未接收任务，本次已安全结束；卡资料已保留。';
          } catch {
            if (!current()) return;
            context.connectorStatus.value = 'offline';
            context.connectorMessage.value = '本机连接器接收结果待核验';
            context.error.value = '本机连接器接收结果不明确，本次不会自动重发。请刷新原任务。';
          }
        }
      } else context.error.value = getApiErrorMessage(cause);
    } finally {
      clear();
      if (clearPending === clear) clearPending = undefined;
      if (launch) {
        launch.agentToken = '';
        launch.connectorToken = '';
        launch.bitBrowser.localApiToken = '';
        launch.bitBrowser.dynamicProxyUrl = '';
        if (launch.savedLogin) launch.savedLogin.password = '';
        if (launch.bitBrowser.staticProxyCredentials)
          launch.bitBrowser.staticProxyCredentials.password = '';
      }
      if (current()) {
        pending = false;
        context.busy.value = false;
        void context.refresh();
      }
    }
  }
  return { start };
}
