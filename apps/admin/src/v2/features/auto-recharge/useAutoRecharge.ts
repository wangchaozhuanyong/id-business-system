import { computed, onScopeDispose, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import type {
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserOpenLaunch,
  V2RechargeBitBrowserRecheckLaunch,
  V2RechargeBitBrowserResolutionLaunch,
  V2RechargeBitBrowserSettings,
  V2RechargeDetails,
  V2RechargeJob,
  V2RechargePlan
} from './contracts';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi, rechargeCallbackUrl, rechargeConnectorApi } from './api';
import { RechargeConnectorError } from './connector-transport';
import { rechargeDetailsReady } from './recharge-form';
import { useRechargeBrowserSettings, type ConnectorStatus } from './useRechargeBrowserSettings';
import { useRechargeTotp } from './useRechargeTotp';
import { bankRechargeApi } from './bank-recharge-api';
import { currencyOptions } from './recharge-presentation';

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

function isAlreadyResolved(
  value: V2RechargeBitBrowserResolutionLaunch | { id: string; alreadyResolved: true }
): value is { id: string; alreadyResolved: true } {
  return 'alreadyResolved' in value && value.alreadyResolved === true;
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
    (settings.browserOptions?.proxyMode === 'static'
      ? Boolean(settings.browserOptions.staticHost && settings.browserOptions.staticPort)
      : settings.dynamicProxyUrlConfigured)
  );
}

export function useAutoRecharge() {
  const currentId = ref('');
  const operationMode = ref<'payment' | 'open_browser'>('payment');
  const loginMethod = ref<'json' | 'password' | 'saved'>('json');
  const selectedBankAccountId = ref('');
  const selectedBankAccountEmail = ref('');
  const loginEmail = ref('');
  const loginPassword = ref('');
  const loginCode = ref('');
  const jsonInput = ref('');
  const sessionJson = ref('');
  const jsonError = ref('');
  const plan = ref<V2RechargePlan>('plus');
  const selectedAddressId = ref('');
  const windowName = ref('');
  const lockedCurrency = ref('PHP');
  const maxAmount = ref('30.00');
  const authorizeSinglePayment = ref(false);
  const details = ref<V2RechargeDetails>(emptyDetails());
  const busy = ref(false);
  const error = ref('');
  const importing = ref(false);
  const connectorStatus = ref<ConnectorStatus>('unknown');
  const connectorMessage = ref('尚未检测本机连接器');
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
  const bankAccountsQuery = useV2ModuleQuery({
    moduleKey: 'chatgpt-accounts',
    scope: 'auto-recharge',
    key: 'auto-recharge-bank-accounts',
    query: ({ signal }) => bankRechargeApi.listAccounts({ signal })
  });
  const bankCurrenciesQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'auto-recharge-bank-currencies',
    query: ({ signal }) => bankRechargeApi.listCurrencies({ signal })
  });
  const browserSettings = useRechargeBrowserSettings(connectorStatus, connectorMessage);
  const { settingsQuery } = browserSettings;
  const totp = useRechargeTotp(loginMethod);

  const jobs = computed(() => query.data.value?.items ?? []);
  const availableAddresses = computed(() => addressQuery.data.value?.items ?? []);
  const savedBankAccounts = computed(() =>
    (bankAccountsQuery.data.value?.items ?? []).filter((item) => item.status === 'active')
  );
  const selectedBankAccount = computed(() =>
    savedBankAccounts.value.find((item) => item.id === selectedBankAccountId.value)
  );
  const availableCurrencyOptions = computed(() =>
    (bankCurrenciesQuery.data.value?.items ?? [])
      .filter((item) => item.active)
      .map((item) => ({
        value: item.code,
        label:
          currencyOptions.find((known) => known.value === item.code)?.label ??
          `${item.name}（${item.code}）`
      }))
  );
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
  const credentialReady = computed(() =>
    loginMethod.value === 'json'
      ? Boolean(sessionJson.value)
      : loginMethod.value === 'saved'
        ? Boolean(selectedBankAccount.value?.hasPassword && selectedBankAccountEmail.value)
        : emailPattern.test(loginEmail.value.trim()) &&
          Boolean(loginPassword.value) &&
          totp.ready.value
  );
  const automaticCodeReady = computed(() =>
    loginMethod.value === 'saved'
      ? Boolean(selectedBankAccount.value?.hasTotp)
      : totp.ready.value && totp.source.value !== 'manual'
  );
  const canStart = computed(
    () =>
      Boolean(
        credentialReady.value &&
        selectedAddress.value &&
        windowName.value.trim() &&
        /^[A-Z]{3}$/.test(lockedCurrency.value) &&
        availableCurrencyOptions.value.some((item) => item.value === lockedCurrency.value) &&
        /^[0-9]{1,9}(?:\.[0-9]{1,2})?$/.test(maxAmount.value) &&
        authorizeSinglePayment.value &&
        rechargeDetailsReady(details.value) &&
        currentSettingsReady.value
      ) &&
      !formLocked.value &&
      query.phase.value === 'ready'
  );
  const canStartOpen = computed(
    () =>
      Boolean(credentialReady.value && windowName.value.trim() && currentSettingsReady.value) &&
      !formLocked.value &&
      query.phase.value === 'ready'
  );
  const canCancel = computed(() => {
    const job = selected.value;
    const connectorNeverReceived =
      job?.state === 'unknown' && job.result.status === 'waiting_local_connector';
    return Boolean(
      job?.action === 'bitbrowser' &&
      (activeStates.has(job.state) || connectorNeverReceived) &&
      job.result.status !== 'cancelling' &&
      job.result.payment_attempted !== true &&
      Number(job.result.payment_requests_sent ?? 0) === 0
    );
  });
  const canRecheck = computed(() => {
    const job = selected.value;
    return Boolean(
      job?.action === 'bitbrowser' &&
      ['finished', 'unknown'].includes(job.state) &&
      (job.result.payment_attempted === true ||
        Number(job.result.payment_requests_sent ?? 0) === 1) &&
      job.result.recheck_only !== true &&
      job.result.payment_status !== 'declined' &&
      job.result.operator_resolution !== 'confirmed_no_bank_request' &&
      job.result.status !== 'subscription_activated' &&
      job.result.payment_outcome !== 'subscription_activated' &&
      credentialReady.value &&
      windowName.value.trim() &&
      currentSettingsReady.value &&
      !busy.value &&
      !active.value &&
      query.phase.value === 'ready'
    );
  });
  const canResolveNoBankRequest = computed(() => {
    const job = selected.value;
    const hasSingleHistoricalRequest =
      Number(job?.result.confirmation_requests_sent ?? 0) === 1 ||
      (Number(job?.result.confirmation_requests_sent ?? 0) === 0 &&
        Number(job?.result.payment_requests_sent ?? 0) === 1);
    return Boolean(
      job &&
      ['finished', 'unknown'].includes(job.state) &&
      job.result.payment_attempted === true &&
      hasSingleHistoricalRequest &&
      job.result.payment_status === 'unknown' &&
      !job.result.payment_evidence &&
      job.result.operator_resolution !== 'confirmed_no_bank_request' &&
      job.result.resolution_verification_job_id &&
      !busy.value &&
      !active.value &&
      settingsQuery.data.value?.connectorTokenConfigured &&
      query.phase.value === 'ready'
    );
  });
  const needsCode = computed(
    () =>
      selected.value?.state === 'awaiting_human_verification' &&
      selected.value.result.stage === 'login_code_required'
  );
  const autoCodeBusy = ref(false);
  const autoCodeFailureJobId = ref('');
  const autoCodeSubmittedJobId = ref('');
  const autoCodeAttempted = new Set<string>();
  const needsManualCode = computed(
    () =>
      needsCode.value &&
      autoCodeSubmittedJobId.value !== selected.value?.id &&
      (!automaticCodeReady.value || autoCodeFailureJobId.value === selected.value?.id)
  );
  const autoCodeMessage = computed(() =>
    autoCodeSubmittedJobId.value === selected.value?.id
      ? '验证码已提交，等待官网确认…'
      : autoCodeBusy.value
        ? '正在自动生成并提交 2FA 验证码…'
        : '正在等待自动取码…'
  );
  const needsHuman = computed(
    () => selected.value?.state === 'awaiting_human_verification' && !needsCode.value
  );
  const workflowMessage = computed(() => {
    const job = selected.value;
    if (job?.result.status === 'cancelling') return '正在停止执行并清理本次窗口，请稍候。';
    if (needsCode.value && autoCodeSubmittedJobId.value === job?.id)
      return '2FA 验证码已提交，正在等待官网确认。';
    if (needsCode.value)
      return needsManualCode.value
        ? '自动取码不可用，请输入当次验证码，或重试自动取码。'
        : '官网要求 TOTP 验证码，正在使用系统 2FA 功能自动取码并提交。';
    if (job?.state === 'awaiting_human_verification')
      return '比特浏览器正在等待人工验证；完成官网或银行验证后点击继续。';
    if (job?.state === 'running') return '本机比特浏览器正在执行，系统不会重复提交付款。';
    if (job?.state === 'unknown') return '原单结果待核验，禁止重新付款。';
    if (job?.state === 'finished') {
      if (job.result.mode === 'open_browser') {
        return '账号登录成功，比特浏览器窗口已打开，可进行手动操作。';
      }
      return '本次流程已结束，请查看官网回传结果。';
    }
    if (!currentSettingsReady.value) return '请先完成比特浏览器设置和本机连接密钥。';
    if (
      loginMethod.value === 'password' &&
      emailPattern.test(loginEmail.value.trim()) &&
      loginPassword.value &&
      !totp.ready.value
    )
      return '请选择已保存的 2FA 账号或粘贴有效密钥；其他验证方式可选手动完成。';
    if (!credentialReady.value)
      return loginMethod.value === 'json'
        ? '粘贴授权 JSON 后会自动载入账号和注册邮箱。'
        : '填写账号和密码后可在比特浏览器登录。';
    if (operationMode.value === 'open_browser') {
      return '核对窗口名称后，点击即可打开比特浏览器并自动登录。';
    }
    return '补齐窗口名称、卡资料、未使用地址和付款上限后，即可一键执行。';
  });

  watch([loginEmail, loginMethod], () => {
    details.value.email =
      loginMethod.value === 'saved'
        ? selectedBankAccountEmail.value
        : loginMethod.value === 'password'
          ? loginEmail.value.trim()
          : sessionJson.value
            ? registrationEmail(JSON.parse(sessionJson.value))
            : '';
    if (
      loginMethod.value === 'password' &&
      !windowName.value.trim() &&
      loginEmail.value.includes('@')
    ) {
      windowName.value = `ChatGPT-${loginEmail.value.split('@')[0]}`;
    }
  });

  watch(selectedBankAccountId, async (id) => {
    selectedBankAccountEmail.value = '';
    if (!id) return;
    try {
      const identity = await bankRechargeApi.accountIdentity(id);
      if (selectedBankAccountId.value !== id || disposed) return;
      selectedBankAccountEmail.value = identity.email;
      if (loginMethod.value === 'saved') details.value.email = identity.email;
      if (!windowName.value.trim()) windowName.value = `ChatGPT-${identity.email.split('@')[0]}`;
    } catch (cause) {
      if (selectedBankAccountId.value === id) error.value = getApiErrorMessage(cause);
    }
  });

  watch(loginMethod, (method) => {
    if (method === 'json') totp.clearSecret();
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

  async function localCredential(savedLogin?: { email: string; password: string }) {
    if (loginMethod.value === 'saved') {
      if (!selectedBankAccountId.value) throw new Error('请先选择已保存的 ChatGPT 账号');
      return {
        login: savedLogin ?? (await bankRechargeApi.loginCredential(selectedBankAccountId.value))
      };
    }
    return loginMethod.value === 'json'
      ? { sessionJson: sessionJson.value }
      : { login: { email: loginEmail.value.trim(), password: loginPassword.value } };
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
      if (!windowName.value.trim()) {
        const prefix = email.split('@')[0] || 'account';
        windowName.value = `ChatGPT-${prefix}`;
      }
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
    let launch: V2RechargeBitBrowserLaunch | null = null;
    try {
      await browserSettings.checkSavedConnection();
      if (disposed) return;
      launch = await rechargeApi.startBitBrowser({
        id,
        plan: plan.value,
        addressId: selectedAddress.value.id,
        windowName: windowName.value.trim(),
        lockedCurrency: lockedCurrency.value,
        maxAmount: maxAmount.value,
        expectedEmail: details.value.email,
        ...(loginMethod.value === 'saved'
          ? {
              chatgptAccountId: selectedBankAccountId.value,
              useSavedCredentials: true
            }
          : {}),
        authorizeSinglePayment: true
      });
      currentId.value = id;
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
        ...(await localCredential(launch.savedLogin)),
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
      if (loginMethod.value === 'password') loginPassword.value = '';
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

  async function startOpen() {
    if (!canStartOpen.value) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    let launch: V2RechargeBitBrowserOpenLaunch | null = null;
    try {
      await browserSettings.checkSavedConnection();
      if (disposed) return;
      launch = await rechargeApi.startBitBrowserOpen({
        id,
        windowName: windowName.value.trim()
      });
      currentId.value = id;
      localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id,
        mode: 'open_browser',
        windowName: windowName.value.trim(),
        ...(await localCredential()),
        bitBrowser: launch.bitBrowser,
        callbackUrl: rechargeCallbackUrl(id),
        agentToken: launch.agentToken
      });
      connectorStatus.value = 'online';
      connectorMessage.value = '本机连接器已接收任务';
      if (loginMethod.value === 'password') loginPassword.value = '';
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
            error.value = '本机连接器未接收任务，本次已安全结束。';
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
      await browserSettings.checkSavedConnection();
      if (disposed) return;
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
        ...(await localCredential()),
        bitBrowser: launch.bitBrowser,
        callbackUrl: rechargeCallbackUrl(id),
        agentToken: launch.agentToken
      });
      connectorStatus.value = 'online';
      connectorMessage.value = '本机连接器已接收只读复查';
      if (loginMethod.value === 'password') loginPassword.value = '';
    } catch (cause) {
      error.value = launch
        ? '本机连接器接收结果不明确，不会新建订单或重复付款。'
        : getApiErrorMessage(cause);
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  async function resolveNoBankRequest() {
    const source = selected.value;
    const verificationJobId = source?.result.resolution_verification_job_id;
    if (!canResolveNoBankRequest.value || !source || !verificationJobId) return;
    try {
      await ElMessageBox.confirm(
        '此操作只记录你已确认银行卡没有收到这笔付款请求，并解除该历史记录对后续充值的阻止。原付款尝试和确认次数会继续保留。',
        '确认银行卡未收到付款请求',
        { confirmButtonText: '确认并处理', cancelButtonText: '取消', type: 'warning' }
      );
    } catch {
      return;
    }
    busy.value = true;
    error.value = '';
    let launch: V2RechargeBitBrowserResolutionLaunch | null = null;
    try {
      const saved = settingsQuery.data.value;
      if (!saved?.connectorTokenConfigured) throw new Error('请先保存本机连接密钥。');
      await rechargeConnectorApi.health(saved.connectorUrl);
      if (disposed) return;
      const response = await rechargeApi.resolveNoBankRequest(source.id, {
        confirmNoBankRequest: true,
        verificationJobId
      });
      if (isAlreadyResolved(response)) {
        connectorMessage.value = '历史付款记录已经处理';
        return;
      }
      launch = response;
      currentId.value = launch.id;
      localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id: launch.id,
        mode: launch.mode,
        plan: launch.plan,
        accountKey: launch.accountKey,
        checkoutIdentifier: launch.checkoutIdentifier,
        sourceJobId: launch.sourceJobId,
        verificationJobId: launch.verificationJobId,
        callbackUrl: rechargeCallbackUrl(launch.id),
        agentToken: launch.agentToken
      });
      connectorStatus.value = 'online';
      connectorMessage.value = '银行卡未收到付款请求的确认已处理';
    } catch (cause) {
      if (launch) {
        try {
          await rechargeConnectorApi.status(launch.connectorUrl, launch.connectorToken, launch.id);
          connectorStatus.value = 'online';
          connectorMessage.value = '本机连接器已接收处理任务';
          error.value = '';
        } catch {
          try {
            await rechargeApi.abandonUnreceivedBitBrowser(launch.id);
            error.value = '本机连接器未接收处理任务，请重新操作。';
          } catch {
            error.value = '本机连接器接收结果待核验，请刷新原任务。';
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

  async function submitLoginCode() {
    if (!needsManualCode.value || busy.value) return;
    if (!/^[0-9]{6,8}$/.test(loginCode.value.trim())) {
      error.value = '请输入当前有效的 6 至 8 位验证码';
      return;
    }
    busy.value = true;
    error.value = '';
    try {
      const current = await access();
      await rechargeConnectorApi.submitCode(
        current.connectorUrl,
        current.connectorToken,
        current.job.id,
        loginCode.value.trim()
      );
      autoCodeSubmittedJobId.value = current.job.id;
      loginCode.value = '';
      await refresh();
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }

  async function submitAutomaticCode(jobId: string) {
    autoCodeBusy.value = true;
    error.value = '';
    try {
      const code =
        loginMethod.value === 'saved'
          ? (await bankRechargeApi.totpCode(selectedBankAccountId.value)).token
          : await totp.freshCode();
      if (!/^[0-9]{6,8}$/.test(code)) throw new Error('2FA 验证码格式无效');
      if (disposed || !needsCode.value || selected.value?.id !== jobId) return;
      const current = await access();
      if (current.job.id !== jobId || disposed || !needsCode.value) return;
      await rechargeConnectorApi.submitCode(
        current.connectorUrl,
        current.connectorToken,
        jobId,
        code
      );
      autoCodeSubmittedJobId.value = jobId;
      totp.clearSecret();
      await refresh();
    } catch (cause) {
      if (
        !disposed &&
        selected.value?.id === jobId &&
        needsCode.value &&
        autoCodeSubmittedJobId.value !== jobId
      ) {
        autoCodeFailureJobId.value = jobId;
        error.value = getApiErrorMessage(cause);
      }
    } finally {
      autoCodeBusy.value = false;
    }
  }

  function retryAutomaticCode() {
    const jobId = selected.value?.id;
    if (
      !jobId ||
      !needsCode.value ||
      !automaticCodeReady.value ||
      autoCodeBusy.value ||
      autoCodeSubmittedJobId.value === jobId
    )
      return;
    autoCodeFailureJobId.value = '';
    autoCodeAttempted.add(jobId);
    void submitAutomaticCode(jobId);
  }

  watch(
    () => (needsCode.value ? selected.value?.id : undefined),
    (jobId) => {
      if (!jobId || disposed || !automaticCodeReady.value || autoCodeAttempted.has(jobId)) return;
      autoCodeAttempted.add(jobId);
      void submitAutomaticCode(jobId);
    },
    { flush: 'post' }
  );

  watch(
    () => selected.value?.state,
    (state) => {
      if (state && !activeStates.has(state)) totp.clearSecret();
    }
  );

  async function cancel() {
    if (!canCancel.value || busy.value || !selected.value) return;
    busy.value = true;
    error.value = '';
    const id = selected.value.id;
    try {
      const current = await access();
      try {
        await rechargeConnectorApi.cancel(current.connectorUrl, current.connectorToken, id);
      } catch (cause) {
        if (!(cause instanceof RechargeConnectorError) || cause.code !== 'missing') throw cause;
        await rechargeApi.abandonUnreceivedBitBrowser(id);
        clearCard();
        if (paymentJobId.value === id) paymentJobId.value = '';
        return;
      }
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

  onScopeDispose(() => {
    disposed = true;
    importGeneration++;
    sessionJson.value = '';
    jsonInput.value = '';
    loginPassword.value = '';
    selectedBankAccountEmail.value = '';
    loginCode.value = '';
    totp.clearSecret();
    localAccess.value = null;
    paymentJobId.value = '';
    Object.assign(details.value, emptyDetails());
  });

  return {
    query,
    addressQuery,
    jobs,
    availableAddresses,
    selectedAddress,
    selectedAddressId,
    selected,
    active,
    jsonInput,
    sessionJson,
    jsonError,
    loginMethod,
    selectedBankAccountId,
    selectedBankAccountEmail,
    savedBankAccounts,
    bankAccountsQuery,
    bankCurrenciesQuery,
    availableCurrencyOptions,
    loginEmail,
    loginPassword,
    loginCode,
    totp,
    totpSource: totp.source,
    totpSecretInput: totp.secretInput,
    savedTotpAccountId: totp.savedAccountId,
    savedTotpAccounts: totp.savedAccounts,
    savedTotpQuery: totp.savedAccountsQuery,
    totpSecretError: totp.secretError,
    totpReady: totp.ready,
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
    operationMode,
    canStart,
    canStartOpen,
    canCancel,
    canRecheck,
    canResolveNoBankRequest,
    needsHuman,
    needsCode,
    needsManualCode,
    autoCodeBusy,
    autoCodeMessage,
    autoCodeFailureJobId,
    autoCodeSubmittedJobId,
    workflowMessage,
    browserSettings,
    ...browserSettings,
    currentSettingsReady,
    acceptSession,
    updateJsonInput,
    importJson,
    start,
    startOpen,
    recheck,
    resolveNoBankRequest,
    selectJob,
    resume,
    submitLoginCode,
    retryAutomaticCode,
    cancel,
    refresh
  };
}
