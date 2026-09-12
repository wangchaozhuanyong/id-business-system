import { computed, onScopeDispose, ref, watch } from 'vue';
import type {
  UpdateV2RechargeBitBrowserSettingsInput,
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserRecheckLaunch,
  V2RechargeBitBrowserSettings,
  V2RechargeDetails,
  V2RechargeJob,
  V2RechargePlan
} from './contracts';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi, rechargeCallbackUrl, rechargeConnectorApi } from './api';
import { rechargeDetailsReady } from './recharge-form';

const activeStates = new Set([
  'running',
  'awaiting_details',
  'awaiting_confirmation',
  'awaiting_human_verification',
  'confirming'
]);
const requiresPolling = (job: V2RechargeJob) =>
  ['running', 'awaiting_human_verification', 'confirming'].includes(job.state);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ConnectorStatus = 'unknown' | 'checking' | 'online' | 'offline';

export interface BitBrowserSettingsForm extends UpdateV2RechargeBitBrowserSettingsInput {
  localApiToken: string;
  connectorToken: string;
  dynamicProxyUrl: string;
}

const emptyDetails = (): V2RechargeDetails => ({
  number: '',
  expiry: '',
  cvc: '',
  name: '',
  email: '',
  country: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal_code: ''
});

const emptySettings = (): BitBrowserSettingsForm => ({
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  localApiToken: '',
  connectorToken: '',
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  proxyType: 'http',
  dynamicProxyUrl: ''
});

function registrationEmail(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const document = value as Record<string, unknown>;
  const candidates: string[] = [];
  const user = document.user;
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    const email = (user as Record<string, unknown>).email;
    if (typeof email === 'string' && emailPattern.test(email.trim())) candidates.push(email.trim());
  }
  for (const key of ['accessToken', 'access_token'] as const) {
    const token = document[key];
    if (typeof token !== 'string' || typeof atob !== 'function') continue;
    try {
      const encoded = token.split('.')[1];
      if (!encoded) continue;
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
      const payload = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
      ) as Record<string, unknown>;
      const profile = payload['https://api.openai.com/profile'];
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        const email = (profile as Record<string, unknown>).email;
        if (typeof email === 'string' && emailPattern.test(email.trim()))
          candidates.push(email.trim());
      }
    } catch {
      /* 官网会再次核对完整凭据；此处只读取注册邮箱。 */
    }
  }
  const unique = [...new Set(candidates.map((email) => email.toLowerCase()))];
  return unique.length === 1 ? candidates[0]! : '';
}

function settingsReady(settings: V2RechargeBitBrowserSettings | undefined) {
  return Boolean(
    settings?.localApiTokenConfigured &&
    settings.connectorTokenConfigured &&
    settings.dynamicProxyUrlConfigured
  );
}

export function useAutoRecharge() {
  const currentId = ref('');
  const jsonInput = ref('');
  const sessionJson = ref('');
  const jsonError = ref('');
  const plan = ref<V2RechargePlan>('plus');
  const selectedAddressId = ref('');
  const windowName = ref('');
  const lockedCurrency = ref('USD');
  const maxAmount = ref('30.00');
  const authorizeSinglePayment = ref(false);
  const details = ref<V2RechargeDetails>(emptyDetails());
  const busy = ref(false);
  const error = ref('');
  const importing = ref(false);
  const connectorStatus = ref<ConnectorStatus>('unknown');
  const connectorMessage = ref('尚未检测本机连接器');
  const settingsOpen = ref(false);
  const settingsSaving = ref(false);
  const settingsForm = ref<BitBrowserSettingsForm>(emptySettings());
  const localAccess = ref<{ connectorUrl: string; connectorToken: string } | null>(null);
  const paymentJobId = ref('');
  let disposed = false;
  let importGeneration = 0;

  const query = useV2ModuleQuery<{ items: V2RechargeJob[]; configured: boolean }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-bitbrowser-jobs',
    keepPreviousData: true,
    getRevalidateAt: (result) =>
      result.items.some(requiresPolling) ||
      Boolean(currentId.value && !result.items.some((job) => job.id === currentId.value))
        ? Date.now() + 2000
        : null,
    query: ({ signal }) => rechargeApi.list({ signal })
  });
  const addressQuery = useV2ModuleQuery<V2RechargeAddressList>({
    moduleKey: 'auto-recharge-addresses',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-unused-addresses',
    keepPreviousData: true,
    query: ({ signal }) =>
      rechargeApi.listAddresses({ page: 1, pageSize: 2000, status: 'unused' }, { signal })
  });
  const settingsQuery = useV2ModuleQuery<V2RechargeBitBrowserSettings>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-bitbrowser-settings',
    keepPreviousData: true,
    query: ({ signal }) => rechargeApi.getBitBrowserSettings({ signal })
  });

  const jobs = computed(() => query.data.value?.items ?? []);
  const availableAddresses = computed(() => addressQuery.data.value?.items ?? []);
  const selectedAddress = computed<V2RechargeAddress | undefined>(() =>
    availableAddresses.value.find((address) => address.id === selectedAddressId.value)
  );
  const selected = computed(() =>
    currentId.value
      ? jobs.value.find((job) => job.id === currentId.value)
      : jobs.value.find((job) => activeStates.has(job.state))
  );
  const active = computed(() => jobs.value.some((job) => activeStates.has(job.state)));
  const currentSettingsReady = computed(() => settingsReady(settingsQuery.data.value));
  const formLocked = computed(() => busy.value || active.value);
  const canStart = computed(
    () =>
      Boolean(
        sessionJson.value &&
        selectedAddress.value &&
        windowName.value.trim() &&
        /^[A-Z]{3}$/.test(lockedCurrency.value) &&
        /^\d{1,9}(?:\.\d{1,2})?$/.test(maxAmount.value) &&
        authorizeSinglePayment.value &&
        rechargeDetailsReady(details.value) &&
        currentSettingsReady.value
      ) &&
      !formLocked.value &&
      query.phase.value === 'ready'
  );
  const canCancel = computed(
    () =>
      selected.value?.action === 'bitbrowser' &&
      activeStates.has(selected.value.state) &&
      selected.value.result.payment_attempted !== true &&
      Number(selected.value.result.payment_requests_sent ?? 0) === 0
  );
  const canRecheck = computed(() => {
    const job = selected.value;
    return Boolean(
      job?.action === 'bitbrowser' &&
      ['finished', 'unknown'].includes(job.state) &&
      (job.result.payment_attempted === true ||
        Number(job.result.payment_requests_sent ?? 0) === 1) &&
      job.result.recheck_only !== true &&
      job.result.payment_status !== 'declined' &&
      job.result.status !== 'subscription_activated' &&
      job.result.payment_outcome !== 'subscription_activated' &&
      sessionJson.value &&
      windowName.value.trim() &&
      currentSettingsReady.value &&
      !busy.value &&
      !active.value &&
      query.phase.value === 'ready'
    );
  });
  const needsHuman = computed(() => selected.value?.state === 'awaiting_human_verification');
  const workflowMessage = computed(() => {
    const job = selected.value;
    if (job?.state === 'awaiting_human_verification')
      return '比特浏览器正在等待人工验证；完成官网或银行验证后点击继续。';
    if (job?.state === 'running') return '本机比特浏览器正在执行，系统不会重复提交付款。';
    if (job?.state === 'unknown') return '原单结果待核验，禁止重新付款。';
    if (job?.state === 'finished') return '本次流程已结束，请查看官网回传结果。';
    if (!currentSettingsReady.value) return '请先完成比特浏览器设置和本机连接密钥。';
    if (!sessionJson.value) return '粘贴授权 JSON 后会自动载入账号和注册邮箱。';
    return '补齐窗口名称、卡资料、未使用地址和付款上限后，即可一键执行。';
  });

  watch(
    [selectedAddressId, availableAddresses, () => addressQuery.phase.value],
    () => {
      const address = selectedAddress.value;
      if (selectedAddressId.value && !address && addressQuery.phase.value === 'ready') {
        selectedAddressId.value = '';
      }
      Object.assign(details.value, {
        country: address?.country ?? '',
        line1: address?.line1 ?? '',
        line2: '',
        city: address?.city ?? '',
        state: address?.state ?? '',
        postal_code: address?.postalCode ?? ''
      });
    },
    { flush: 'sync' }
  );

  watch(
    () => settingsQuery.data.value,
    (settings) => {
      if (!settings || settingsSaving.value) return;
      settingsForm.value = {
        connectorUrl: settings.connectorUrl,
        localApiUrl: settings.localApiUrl,
        localApiToken: '',
        connectorToken: '',
        groupName: settings.groupName,
        tagName: settings.tagName,
        proxyType: settings.proxyType,
        dynamicProxyUrl: ''
      };
    },
    { immediate: true }
  );

  watch(
    () => [
      paymentJobId.value,
      jobs.value.find((job) => job.id === paymentJobId.value)?.result.payment_attempted
    ],
    async () => {
      const paymentJob = jobs.value.find((job) => job.id === paymentJobId.value);
      if (!paymentJob?.result.payment_attempted) return;
      clearCard();
      paymentJobId.value = '';
      await addressQuery.refresh();
    },
    { flush: 'post' }
  );

  function clearCard() {
    details.value.number = '';
    details.value.expiry = '';
    details.value.cvc = '';
  }

  function acceptSession(reportInvalid = true) {
    importGeneration++;
    if (formLocked.value) return;
    if (!jsonInput.value.trim()) {
      if (reportInvalid) jsonError.value = '请粘贴完整的单账户授权 JSON';
      return;
    }
    try {
      if (new TextEncoder().encode(jsonInput.value).length > 65_000) throw new Error();
      const value = JSON.parse(jsonInput.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const email = registrationEmail(value);
      if (!email) {
        jsonError.value = '授权 JSON 中未找到唯一有效的 ChatGPT 注册邮箱';
        return;
      }
      sessionJson.value = jsonInput.value;
      details.value.email = email;
      jsonInput.value = '';
      jsonError.value = '';
    } catch {
      if (reportInvalid) jsonError.value = '请提供有效的单账户 JSON（不超过 65 KB）';
    }
  }

  function updateJsonInput(value: string) {
    if (formLocked.value) return;
    jsonInput.value = value;
    sessionJson.value = '';
    details.value.email = '';
    if (!value.trim()) {
      jsonError.value = '';
      return;
    }
    acceptSession(false);
  }

  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const generation = ++importGeneration;
    if (!file || formLocked.value) return;
    importing.value = true;
    try {
      if (file.size > 65_000) throw new Error();
      const value = await file.text();
      if (!disposed && generation === importGeneration) {
        jsonInput.value = value;
        acceptSession();
      }
    } catch {
      if (!disposed) jsonError.value = '文件读取失败，请选择不超过 65 KB 的 JSON 或文本文件';
    } finally {
      importing.value = false;
      input.value = '';
    }
  }

  async function refresh() {
    try {
      await query.refresh();
    } catch {
      /* 读取失败由异步区域展示。 */
    }
  }

  async function start() {
    if (!canStart.value || !selectedAddress.value) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    currentId.value = id;
    let launch: V2RechargeBitBrowserLaunch | null = null;
    try {
      launch = await rechargeApi.startBitBrowser({
        id,
        plan: plan.value,
        addressId: selectedAddress.value.id,
        windowName: windowName.value.trim(),
        lockedCurrency: lockedCurrency.value,
        maxAmount: maxAmount.value,
        authorizeSinglePayment: true
      });
      paymentJobId.value = id;
      localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      const payment = {
        number: details.value.number,
        expiry: details.value.expiry,
        cvc: details.value.cvc,
        name: details.value.name,
        email: details.value.email
      };
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id,
        mode: launch.mode,
        plan: plan.value,
        windowName: windowName.value.trim(),
        sessionJson: sessionJson.value,
        details: payment,
        address: launch.address,
        bitBrowser: launch.bitBrowser,
        safety: launch.safety,
        callbackUrl: rechargeCallbackUrl(id),
        agentToken: launch.agentToken,
        authorizeSinglePayment: true
      });
      connectorStatus.value = 'online';
      connectorMessage.value = '本机连接器已接收任务';
    } catch (cause) {
      if (launch) {
        try {
          await rechargeConnectorApi.status(launch.connectorUrl, launch.connectorToken, id);
          connectorStatus.value = 'online';
          connectorMessage.value = '本机连接器已接收，本次不会重发';
          error.value = '';
        } catch {
          try {
            await rechargeApi.abandonUnreceivedBitBrowser(id);
            connectorStatus.value = 'offline';
            connectorMessage.value = '本机连接器未接收';
            error.value = '本机连接器未接收任务，本次已安全结束；卡资料已保留。';
          } catch {
            connectorStatus.value = 'offline';
            connectorMessage.value = '本机连接器接收结果待核验';
            error.value = '本机连接器接收结果不明确，本次不会自动重发。请刷新原任务。';
          }
        }
      } else {
        error.value = getApiErrorMessage(cause);
      }
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  function selectJob(id: string) {
    currentId.value = id;
    localAccess.value = null;
  }

  async function recheck() {
    const source = selected.value;
    if (!canRecheck.value || !source) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    let launch: V2RechargeBitBrowserRecheckLaunch | null = null;
    try {
      launch = await rechargeApi.recheckBitBrowser({
        id,
        sourceJobId: source.id,
        plan: source.plan,
        windowName: windowName.value.trim()
      });
      currentId.value = id;
      localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id,
        mode: launch.mode,
        plan: source.plan,
        windowName: windowName.value.trim(),
        sessionJson: sessionJson.value,
        bitBrowser: launch.bitBrowser,
        callbackUrl: rechargeCallbackUrl(id),
        agentToken: launch.agentToken
      });
      connectorStatus.value = 'online';
      connectorMessage.value = '本机连接器已接收只读复查';
    } catch (cause) {
      error.value = launch
        ? '本机连接器接收结果不明确，不会新建订单或重复付款。'
        : getApiErrorMessage(cause);
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  async function access() {
    const job = selected.value;
    if (!job) throw new Error('当前没有可操作的本机任务');
    if (!localAccess.value) localAccess.value = await rechargeApi.bitBrowserAccess(job.id);
    return { job, ...localAccess.value };
  }

  async function resume() {
    if (!needsHuman.value || busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      const current = await access();
      await rechargeConnectorApi.resume(
        current.connectorUrl,
        current.connectorToken,
        current.job.id
      );
      connectorStatus.value = 'online';
    } catch (cause) {
      try {
        const current = await access();
        const status = await rechargeConnectorApi.status(
          current.connectorUrl,
          current.connectorToken,
          current.job.id
        );
        error.value =
          status.waitingForUser === false ? '' : '本机连接器尚未确认继续，本次不会自动重发。';
      } catch {
        error.value = cause instanceof Error ? cause.message : '本机连接器恢复失败';
      }
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  async function cancel() {
    if (!canCancel.value || busy.value || !selected.value) return;
    busy.value = true;
    error.value = '';
    const id = selected.value.id;
    try {
      const current = await access();
      await rechargeConnectorApi
        .cancel(current.connectorUrl, current.connectorToken, id)
        .catch(() => undefined);
      await rechargeApi.cancelBitBrowser(id);
      clearCard();
      if (paymentJobId.value === id) paymentJobId.value = '';
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  async function testConnector() {
    connectorStatus.value = 'checking';
    connectorMessage.value = '正在检测本机连接器';
    try {
      await rechargeConnectorApi.health(settingsForm.value.connectorUrl);
      connectorStatus.value = 'online';
      connectorMessage.value = '本机连接器已就绪';
    } catch {
      connectorStatus.value = 'offline';
      connectorMessage.value = '本机连接器不可用，请先启动连接器并允许当前网站来源';
    }
  }

  async function saveSettings() {
    const stored = settingsQuery.data.value;
    if (
      (!stored?.localApiTokenConfigured && !settingsForm.value.localApiToken) ||
      (!stored?.connectorTokenConfigured && !settingsForm.value.connectorToken) ||
      (!stored?.dynamicProxyUrlConfigured && !settingsForm.value.dynamicProxyUrl)
    ) {
      error.value = '首次保存请填写 Local API Token、本机连接密钥和动态 IP 提取链接。';
      return;
    }
    settingsSaving.value = true;
    error.value = '';
    try {
      const updated = await rechargeApi.updateBitBrowserSettings({
        ...settingsForm.value,
        localApiToken: settingsForm.value.localApiToken || undefined,
        connectorToken: settingsForm.value.connectorToken || undefined,
        dynamicProxyUrl: settingsForm.value.dynamicProxyUrl || undefined
      });
      settingsQuery.data.value = updated;
      settingsOpen.value = false;
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      settingsSaving.value = false;
    }
  }

  onScopeDispose(() => {
    disposed = true;
    importGeneration++;
    sessionJson.value = '';
    jsonInput.value = '';
    localAccess.value = null;
    paymentJobId.value = '';
    Object.assign(details.value, emptyDetails());
    Object.assign(settingsForm.value, emptySettings());
  });

  return {
    query,
    addressQuery,
    settingsQuery,
    jobs,
    availableAddresses,
    selectedAddress,
    selectedAddressId,
    selected,
    active,
    jsonInput,
    sessionJson,
    jsonError,
    plan,
    windowName,
    lockedCurrency,
    maxAmount,
    authorizeSinglePayment,
    details,
    busy,
    error,
    importing,
    formLocked,
    canStart,
    canCancel,
    canRecheck,
    needsHuman,
    workflowMessage,
    settingsOpen,
    settingsSaving,
    settingsForm,
    currentSettingsReady,
    connectorStatus,
    connectorMessage,
    acceptSession,
    updateJsonInput,
    importJson,
    start,
    recheck,
    selectJob,
    resume,
    cancel,
    refresh,
    testConnector,
    saveSettings
  };
}
