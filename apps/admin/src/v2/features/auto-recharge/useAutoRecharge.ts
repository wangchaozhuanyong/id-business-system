import { normalizeV2RechargeConnectorUrl } from '@apple-business/shared';
import { computed, nextTick, onScopeDispose, reactive, ref, toRefs, watch } from 'vue';
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
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { rechargeApi, rechargeCallbackUrl, rechargeConnectorApi } from './api';
import { RechargeConnectorError } from './connector-transport';
import { rechargeDetailsReady } from './recharge-form';
import { useRechargeBrowserSettings, type ConnectorStatus } from './useRechargeBrowserSettings';
import { useRechargeNameMatch } from './useRechargeNameMatch';
import { bankRechargeApi } from './bank-recharge-api';
import { canSelectRechargeAccount } from './recharge-account-options';
import { currencyOptions } from './recharge-presentation';
import { rechargeProxyApi, type RechargeProxyItem } from './recharge-proxy-api';
import { useBitBrowserDirectOpen } from './useBitBrowserDirectOpen';
import { parseDirectCredential } from './bitbrowser-direct-credential';
import { isV2TotpCodeCurrent } from '@/v2/components/workspace/totp';

const activeStates = new Set([
  'running',
  'awaiting_details',
  'awaiting_confirmation',
  'awaiting_human_verification',
  'confirming'
]);
const requiresPolling = (job: V2RechargeJob) =>
  ['running', 'awaiting_confirmation', 'awaiting_human_verification', 'confirming'].includes(
    job.state
  );
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isAlreadyResolved(
  value: V2RechargeBitBrowserResolutionLaunch | { id: string; alreadyResolved: true }
): value is { id: string; alreadyResolved: true } {
  return 'alreadyResolved' in value && value.alreadyResolved === true;
}

const emptyDetails = (): Omit<V2RechargeDetails, 'cvc'> => ({
  number: '',
  expiry: '',
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

function settingsReady(
  settings: V2RechargeBitBrowserSettings | undefined,
  selectedProxy = false,
  directMode = false
) {
  return Boolean(
    settings?.localApiTokenConfigured &&
    (directMode || settings.connectorTokenConfigured) &&
    (selectedProxy ||
      settings.proxyId ||
      (settings.browserOptions?.proxyMode === 'static'
        ? Boolean(settings.browserOptions.staticHost && settings.browserOptions.staticPort)
        : settings.dynamicProxyUrlConfigured))
  );
}

async function loadCountryProxies(countryCode: string, signal?: AbortSignal) {
  const items: RechargeProxyItem[] = [];
  if (!countryCode) return { items, total: 0 };
  for (let page = 1; ; page++) {
    const result = await rechargeProxyApi.list(
      { page, pageSize: 100, status: 'active', countryCode },
      { signal }
    );
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) return { items, total: result.total };
  }
}

export function useAutoRecharge(options: { clearPaymentValidation?: () => void } = {}) {
  const execution = useV2SessionDraft('auto-recharge-execution', () => ({
    currentId: ref(''),
    paymentJobId: ref(''),
    settledJobId: '',
    completePaymentSave: null as (() => boolean) | null,
    secretRevision: 0
  }));
  const { currentId, paymentJobId } = execution;
  const formDraft = useV2FormDraft('auto-recharge-form', () => ({
    operationMode: 'payment' as 'payment' | 'open_browser',
    loginMethod: 'json' as 'json' | 'password',
    selectedBankAccountId: '',
    selectedPaymentCardId: '',
    selectedCardBillingAddressId: '',
    manualAddressSelectionRevision: 0,
    selectedBankAccountEmail: '',
    jsonInput: '',
    sessionJson: '',
    jsonError: '',
    plan: 'plus' as V2RechargePlan,
    selectedAddressId: '',
    addressSource: 'library' as 'library' | 'manual',
    windowName: '',
    lockedCurrency: 'PHP',
    selectedProxyCountryCode: '',
    selectedProxyId: '',
    details: emptyDetails()
  }));
  formDraft.open('new');
  // 同一标签页仍持有旧表单草稿时，只迁移入口与账号来源，不沿用旧的手填密码。
  const restored = formDraft.form as unknown as Record<string, unknown>;
  if (restored.operationMode === 'server_payment') formDraft.form.operationMode = 'payment';
  if (restored.loginMethod === 'saved') formDraft.form.loginMethod = 'password';
  formDraft.form.addressSource = 'library';
  delete restored.loginEmail;
  delete restored.loginPassword;
  delete restored.maxAmount;
  const {
    operationMode,
    loginMethod,
    selectedBankAccountId,
    selectedPaymentCardId,
    selectedCardBillingAddressId,
    manualAddressSelectionRevision,
    selectedBankAccountEmail,
    jsonInput,
    sessionJson,
    jsonError,
    plan,
    selectedAddressId,
    addressSource,
    windowName,
    lockedCurrency,
    selectedProxyCountryCode,
    selectedProxyId
  } = toRefs(formDraft.form);
  const paymentDetails = reactive({ ...toRefs(formDraft.form.details), cvc: ref('') });
  const details = computed<V2RechargeDetails>({
    get: () => paymentDetails,
    set: (value) => Object.assign(paymentDetails, value)
  });
  const loginCode = ref('');
  const authorizeSinglePayment = ref(false);
  const busy = ref(false);
  const error = ref('');
  const importing = ref(false);
  const paymentCardLoading = ref(false);
  const resettingPaymentFields = ref(false);
  const connectorStatus = ref<ConnectorStatus>('unknown');
  const connectorMessage = ref('尚未检测本机连接器');
  const localAccess = ref<{ connectorUrl: string; connectorToken: string } | null>(null);
  let disposed = false;
  let importGeneration = 0;
  let paymentCardGeneration = 0;

  const query = useV2ModuleQuery<{ items: V2RechargeJob[]; configured: boolean }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-bitbrowser-jobs',
    keepPreviousData: true,
    getRevalidateAt: (result) =>
      result.items.some(requiresPolling) ||
      Boolean(paymentJobId.value && !result.items.some((job) => job.id === paymentJobId.value)) ||
      Boolean(
        currentId.value &&
        currentId.value !== execution.settledJobId &&
        !result.items.some((job) => job.id === currentId.value)
      )
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
      rechargeApi.listAddresses({ page: 1, pageSize: 2000, status: 'all' }, { signal })
  });
  const bankAccountsQuery = useV2ModuleQuery({
    moduleKey: 'chatgpt-accounts',
    scope: 'auto-recharge',
    key: 'auto-recharge-bank-accounts',
    query: ({ signal }) => bankRechargeApi.listAccounts({ signal }, { subscriptionState: 'all' })
  });
  const bankCurrenciesQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'auto-recharge-bank-currencies',
    query: ({ signal }) => bankRechargeApi.listCurrencies({ signal })
  });
  const paymentCardsQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-cards',
    scope: 'auto-recharge',
    key: 'auto-recharge-payment-cards',
    query: ({ signal }) => bankRechargeApi.listCards({ signal })
  });
  const proxyCountriesQuery = useV2ModuleQuery({
    moduleKey: 'recharge-proxies',
    scope: 'auto-recharge',
    key: 'auto-recharge-proxy-countries',
    query: ({ signal }) => rechargeProxyApi.countries({ signal })
  });
  const proxiesQuery = useV2ModuleQuery({
    moduleKey: 'recharge-proxies',
    scope: 'auto-recharge',
    key: () => `auto-recharge-proxies:${selectedProxyCountryCode.value}`,
    keepPreviousData: true,
    query: ({ signal }) => loadCountryProxies(selectedProxyCountryCode.value, signal)
  });
  watch(
    selectedProxyCountryCode,
    () => {
      selectedProxyId.value = '';
      void proxiesQuery.ensureFresh();
    },
    { flush: 'sync' }
  );
  watch(lockedCurrency, () => {
    selectedProxyCountryCode.value = '';
    selectedProxyId.value = '';
  });
  const browserSettings = useRechargeBrowserSettings(
    connectorStatus,
    connectorMessage,
    ref(false),
    computed(() => operationMode.value === 'open_browser')
  );
  const directOpen = useBitBrowserDirectOpen(refresh, (message) => {
    error.value = message;
  });
  const { settingsQuery } = browserSettings;
  function openProxySettings() {
    browserSettings.setSettingsOpen(true);
  }
  watch(
    () => details.value.cvc,
    () => execution.secretRevision++,
    { flush: 'sync' }
  );

  const jobs = computed(() => query.data.value?.items ?? []);
  const availableAddresses = computed(() =>
    (addressQuery.data.value?.items ?? [])
      .filter((item) => item.status !== 'disabled')
      .sort(
        (a, b) =>
          (a.usedAt ?? '').localeCompare(b.usedAt ?? '') ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
      )
  );
  const savedBankAccounts = computed(() =>
    (bankAccountsQuery.data.value?.items ?? []).filter((item) => canSelectRechargeAccount(item))
  );
  const savedPaymentCards = computed(() =>
    (paymentCardsQuery.data.value?.items ?? []).filter(
      (item) => item.active && item.hasNumber && item.currencyCode === lockedCurrency.value
    )
  );
  const availableProxyCountries = computed(() => proxyCountriesQuery.data.value?.items ?? []);
  function markProxySelectionManual() {}
  const availableProxies = computed(() =>
    selectedProxyCountryCode.value
      ? (proxiesQuery.data.value?.items ?? []).filter(
          (item) => item.countryCode === selectedProxyCountryCode.value && item.status === 'active'
        )
      : []
  );
  const proxySelectionReady = computed(
    () =>
      proxyCountriesQuery.phase.value === 'ready' &&
      !proxyCountriesQuery.error.value &&
      (availableProxyCountries.value.length === 0 ||
        Boolean(
          selectedProxyCountryCode.value &&
          selectedProxyId.value &&
          proxiesQuery.phase.value === 'ready' &&
          !proxiesQuery.error.value &&
          availableProxies.value.some((item) => item.id === selectedProxyId.value)
        ))
  );

  async function selectSavedCard(id: string) {
    if (disposed || busy.value || active.value) return;
    const generation = ++paymentCardGeneration;
    selectedPaymentCardId.value = id;
    paymentCardLoading.value = Boolean(id);
    if (!id) return;
    details.value.cvc = '';
    const addressRevision = manualAddressSelectionRevision.value;
    error.value = '';
    try {
      const card = await bankRechargeApi.managedCardDetail(id);
      if (generation !== paymentCardGeneration || selectedPaymentCardId.value !== id || disposed)
        return;
      if (busy.value || active.value) {
        selectedPaymentCardId.value = '';
        return;
      }
      if (
        card.id !== id ||
        card.status !== 'active' ||
        card.currencyCode !== lockedCurrency.value ||
        !card.number ||
        !card.expiry
      ) {
        throw new Error('这张银行卡已停用、币种不符或资料不完整');
      }
      details.value.number = card.number;
      details.value.expiry = card.expiry;
      details.value.cvc = '';
      if (card.billingName) details.value.name = card.billingName;
      // 卡号监听会清除旧选择；完整资料写入后再登记本次卡号对应的编号。
      selectedPaymentCardId.value = id;
      selectedCardBillingAddressId.value = card.billingAddressId ?? '';
      if (card.billingAddressId && manualAddressSelectionRevision.value === addressRevision) {
        addressSource.value = 'library';
        selectedAddressId.value = availableAddresses.value.some(
          (item) => item.id === card.billingAddressId
        )
          ? card.billingAddressId
          : '';
      }
    } catch (cause) {
      if (!disposed && generation === paymentCardGeneration && selectedPaymentCardId.value === id) {
        selectedPaymentCardId.value = '';
        error.value = getApiErrorMessage(cause);
      }
    } finally {
      if (generation === paymentCardGeneration) paymentCardLoading.value = false;
    }
  }
  watch(selectedPaymentCardId, () => (selectedCardBillingAddressId.value = ''), { flush: 'sync' });
  function markAddressSelectionManual() {
    manualAddressSelectionRevision.value++;
  }
  watch(lockedCurrency, () => {
    if (!selectedPaymentCardId.value) return;
    selectedPaymentCardId.value = '';
    details.value.number = '';
    details.value.expiry = '';
    details.value.cvc = '';
  });
  const selectedBankAccount = computed(() =>
    savedBankAccounts.value.find((item) => item.id === selectedBankAccountId.value)
  );
  const loginCountryRestriction = ref('');
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
      : (jobs.value.find((job) => activeStates.has(job.state)) ??
        jobs.value.find((job) => job.state === 'unknown' && job.result.payment_attempted === true))
  );
  const active = computed(() => jobs.value.some((job) => activeStates.has(job.state)));
  const currentSettingsReady = computed(() =>
    settingsReady(
      settingsQuery.data.value,
      operationMode.value === 'payment' && Boolean(selectedProxyId.value),
      operationMode.value === 'open_browser'
    )
  );
  const formLocked = computed(
    () =>
      busy.value ||
      resettingPaymentFields.value ||
      active.value ||
      directOpen.running.value ||
      paymentCardLoading.value ||
      Boolean(paymentJobId.value && !jobs.value.some((job) => job.id === paymentJobId.value))
  );
  const paymentRetryBlocked = computed(() => {
    const job = selected.value;
    return Boolean(
      job &&
      job.result.mode !== 'open_browser' &&
      (job.state === 'unknown' ||
        ((job.result.payment_attempted === true ||
          Number(job.result.payment_requests_sent ?? 0) > 0 ||
          Number(job.result.confirmation_requests_sent ?? 0) > 0) &&
          job.result.status !== 'subscription_activated' &&
          job.result.payment_status !== 'declined' &&
          job.result.operator_resolution !== 'confirmed_no_bank_request'))
    );
  });
  const credentialReady = computed(() =>
    loginMethod.value === 'json'
      ? Boolean(sessionJson.value && !importing.value && !jsonError.value)
      : Boolean(selectedBankAccount.value?.hasPassword && selectedBankAccountEmail.value)
  );
  const automaticCodeReady = computed(
    () =>
      loginMethod.value === 'password' &&
      selected.value?.chatgptAccountId === selectedBankAccountId.value &&
      Boolean(selectedBankAccount.value?.hasTotp)
  );
  const nameMatch = useRechargeNameMatch(
    details,
    selectedPaymentCardId,
    formLocked,
    (addressId) => {
      selectedCardBillingAddressId.value = addressId ?? '';
    }
  );
  const canStart = computed(
    () =>
      Boolean(
        credentialReady.value &&
        Boolean(selectedAddress.value) &&
        windowName.value.trim() &&
        /^[A-Z]{3}$/.test(lockedCurrency.value) &&
        availableCurrencyOptions.value.some((item) => item.value === lockedCurrency.value) &&
        proxySelectionReady.value &&
        !loginCountryRestriction.value &&
        !nameMatch.error.value &&
        authorizeSinglePayment.value &&
        rechargeDetailsReady(details.value) &&
        currentSettingsReady.value
      ) &&
      !formLocked.value &&
      !paymentRetryBlocked.value &&
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
    const interruptedDirectLogin =
      job?.state === 'unknown' &&
      job.result.mode === 'open_browser' &&
      job.result.transport === 'web_direct';
    return Boolean(
      job &&
      ['bitbrowser', 'server'].includes(job.action) &&
      job.state !== 'confirming' &&
      (activeStates.has(job.state) || connectorNeverReceived || interruptedDirectLogin) &&
      (job.result.status !== 'cancelling' ||
        (job.result.mode === 'open_browser' && job.result.transport === 'web_direct')) &&
      job.result.payment_attempted !== true &&
      Number(job.result.payment_requests_sent ?? 0) === 0
    );
  });
  const canRecheck = computed(() => {
    const job = selected.value;
    if (!job) return false;
    return Boolean(
      job.action === 'bitbrowser' &&
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
      settingsReady(settingsQuery.data.value) &&
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
      job.action === 'bitbrowser' &&
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
      selected.value?.action === 'bitbrowser' &&
      selected.value.result.stage === 'login_code_required' &&
      (selected.value.result.transport !== 'web_direct' || directOpen.owns(selected.value.id))
  );
  const autoCodeBusy = ref(false);
  const autoCodeFailureJobId = ref('');
  const autoCodeSubmittedJobId = ref('');
  const autoCodeAttempted = new Set<string>();
  let autoCodeController: AbortController | undefined;
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
    () =>
      selected.value?.action === 'bitbrowser' &&
      selected.value.state === 'awaiting_human_verification' &&
      !needsCode.value &&
      (selected.value.result.transport !== 'web_direct' || directOpen.owns(selected.value.id))
  );
  const resumeActionLabel = computed(() =>
    selected.value?.result.transport === 'web_direct'
      ? '我已完成验证，刷新核对'
      : '我已完成验证，继续原任务'
  );
  const canContinueSameAccount = computed(() => {
    const job = selected.value;
    return Boolean(
      job &&
      job.action === 'bitbrowser' &&
      job.state === 'finished' &&
      job.result.status === 'subscription_activated' &&
      job.result.payment_status === 'paid' &&
      job.result.payment_outcome === 'subscription_activated' &&
      job.result.account_matched === true &&
      ['go', 'plus'].includes(job.plan) &&
      !formLocked.value
    );
  });
  function continueSameAccount() {
    const job = selected.value;
    if (!canContinueSameAccount.value || !job) return;
    if (job.chatgptAccountId) selectedBankAccountId.value = job.chatgptAccountId;
    plan.value = job.plan === 'go' ? 'plus' : 'pro-5x';
    operationMode.value = 'payment';
    details.value.cvc = '';
    authorizeSinglePayment.value = false;
    currentId.value = '';
    localAccess.value = null;
    error.value =
      loginMethod.value === 'json'
        ? '请重新载入此账号的授权 JSON，并填写本次安全码与单次授权。'
        : '';
  }

  const workflowMessage = computed(() => {
    const job = selected.value;
    if (
      job?.result.transport === 'web_direct' &&
      activeStates.has(job.state) &&
      !directOpen.owns(job.id)
    )
      return '此登录任务由原网页直连执行。本页可停止本次登录并解锁资料；继续核对需回到原网页。';
    if (job?.result.status === 'cancelling') return '正在停止执行并清理本次窗口，请稍候。';
    if (needsCode.value && autoCodeSubmittedJobId.value === job?.id)
      return '2FA 验证码已提交，正在等待官网确认。';
    if (needsCode.value)
      return needsManualCode.value
        ? '自动取码不可用，请输入当次验证码，或重试自动取码。'
        : '官网要求 TOTP 验证码，正在使用系统 2FA 功能自动取码并提交。';
    if (job?.state === 'awaiting_human_verification' && job.result.transport === 'web_direct')
      return '请在已打开的比特官网窗口完成验证；网页会自动核对登录结果，也可点击刷新核对。';
    if (job?.state === 'awaiting_confirmation')
      return '官网报价已取得，等待本人核对金额并确认本次单次付款。';
    if (job?.action === 'server' && job.state === 'awaiting_human_verification')
      return '官网要求本人验证，请打开原付款验证窗口完成验证后核对原单。';
    if (job?.state === 'awaiting_human_verification')
      return '比特浏览器正在等待人工验证；完成官网或银行验证后点击继续。';
    if (job?.state === 'running' && job.result.transport === 'web_direct')
      return '网页正在登录并核对官网账号，请保留当前管理页面。';
    if (job?.state === 'running')
      return job.action === 'server'
        ? '服务器正在执行，本任务最多提交一次付款。'
        : '本机比特浏览器正在执行，系统不会重复提交付款。';
    if (job?.state === 'unknown') return '原单结果待核验，禁止重新付款。';
    if (job?.state === 'finished') {
      if (job.result.mode === 'open_browser') {
        return job.result.status === 'session_ready' && job.result.account_matched
          ? '账号登录成功，比特浏览器窗口已打开，可进行手动操作。'
          : '本次登录已停止，请查看具体原因并检查原窗口。';
      }
      if (job.result.status === 'already_subscribed')
        return '官网已核实该账号已是目标套餐，本次未提交付款。';
      if (job.result.status === 'subscription_activated')
        return '付款与套餐生效均已核实；可继续为同一账号选择下一套餐。';
      return paymentRetryBlocked.value
        ? '本次付款已有提交记录，请只读复查原订单；填写资料已保留。'
        : '本次充值未成功，填写资料已保留；修正原因后可再次执行。';
    }
    if (!currentSettingsReady.value) return '请先完成比特浏览器设置和本机充值助手的连接配置。';
    if (!credentialReady.value)
      return loginMethod.value === 'json'
        ? '粘贴授权 JSON 后会自动载入账号邮箱。'
        : '请从 ChatGPT 账号资料中选择已保存登录密码的账号。';
    if (operationMode.value === 'open_browser')
      return '核对窗口名称后，点击即可打开比特浏览器并自动登录。';
    return '补齐银行卡与账单地址，核实官网币种和金额后等待你确认本次付款。';
  });

  watch(loginMethod, () => {
    importGeneration++;
    importing.value = false;
    details.value.email =
      loginMethod.value === 'password'
        ? selectedBankAccountEmail.value
        : sessionJson.value
          ? registrationEmail(JSON.parse(sessionJson.value))
          : '';
  });

  watch(selectedBankAccountId, async (id) => {
    selectedBankAccountEmail.value = '';
    if (!id) return;
    try {
      const identity = await bankRechargeApi.accountIdentity(id);
      if (selectedBankAccountId.value !== id || disposed) return;
      selectedBankAccountEmail.value = identity.email;
      if (loginMethod.value === 'password') details.value.email = identity.email;
      if (!windowName.value.trim()) windowName.value = `ChatGPT-${identity.email.split('@')[0]}`;
    } catch (cause) {
      if (selectedBankAccountId.value === id) error.value = getApiErrorMessage(cause);
    }
  });

  watch(
    [
      selectedAddressId,
      selectedCardBillingAddressId,
      availableAddresses,
      operationMode,
      addressSource,
      () => addressQuery.phase.value,
      () => addressQuery.error.value
    ],
    () => {
      if (operationMode.value === 'open_browser') return;
      let address = selectedAddress.value;
      if (!address) {
        if (addressQuery.phase.value !== 'ready' || addressQuery.error.value) return;
        address = selectedCardBillingAddressId.value
          ? availableAddresses.value.find((item) => item.id === selectedCardBillingAddressId.value)
          : availableAddresses.value[0];
        const nextId = address?.id ?? '';
        if (selectedAddressId.value !== nextId) {
          selectedAddressId.value = nextId;
          return;
        }
      }
      Object.assign(details.value, {
        country: address?.country ?? '',
        line1: address?.line1 ?? '',
        line2: address?.line2 ?? '',
        city: address?.city ?? '',
        state: address?.state ?? '',
        postal_code: address?.postalCode ?? ''
      });
    },
    { flush: 'sync', immediate: true }
  );

  watch(
    () => [paymentJobId.value, jobs.value.find((job) => job.id === paymentJobId.value)],
    async () => {
      const paymentJob = jobs.value.find((job) => job.id === paymentJobId.value);
      if (paymentJob?.state === 'finished') {
        const result = paymentJob.result;
        const definitelyNotAttempted =
          (result.payment_attempted === false || result.payment_requests_sent === 0) &&
          result.payment_attempted !== true &&
          Number(result.payment_requests_sent ?? 0) === 0 &&
          Number(result.confirmation_requests_sent ?? 0) === 0 &&
          !result.payment_evidence &&
          result.payment_status !== 'paid' &&
          !['paid_pending_activation', 'subscription_activated'].includes(result.status ?? '');
        if (
          definitelyNotAttempted ||
          result.payment_status === 'declined' ||
          result.operator_resolution === 'confirmed_no_bank_request'
        ) {
          // 已确认结束只释放回执追踪；失败资料和未知付款保护仍由各自状态管理。
          execution.settledJobId = paymentJob.id;
          execution.completePaymentSave = null;
          paymentJobId.value = '';
          return;
        }
      }
      if (
        paymentJob?.state !== 'finished' ||
        paymentJob.result.status !== 'subscription_activated' ||
        paymentJob.result.payment_status !== 'paid'
      )
        return;
      const completePaymentSave = execution.completePaymentSave;
      execution.completePaymentSave = null;
      if (completePaymentSave?.()) {
        resettingPaymentFields.value = true;
        clearCard();
        sessionJson.value = '';
        jsonInput.value = '';
        jsonError.value = '';
        selectedPaymentCardId.value = '';
        authorizeSinglePayment.value = false;
        // 清理已提交快照后，为下一笔输入重新登记同一表单。
        formDraft.open('new', { ...formDraft.form });
        await nextTick();
        options.clearPaymentValidation?.();
        resettingPaymentFields.value = false;
      }
      execution.completePaymentSave = null;
      execution.settledJobId = paymentJob.id;
      paymentJobId.value = '';
      await Promise.allSettled([
        addressQuery.refresh(),
        paymentCardsQuery.refresh(),
        bankAccountsQuery.refresh()
      ]);
    },
    { deep: true, immediate: true, flush: 'post' }
  );

  function beginPaymentSave(id: string) {
    const complete = formDraft.beginSave();
    const secretRevision = execution.secretRevision;
    return () => {
      paymentJobId.value = id;
      execution.completePaymentSave = () =>
        execution.secretRevision === secretRevision && complete();
    };
  }

  function clearCard() {
    details.value.number = '';
    details.value.expiry = '';
    details.value.cvc = '';
  }

  async function localCredential(savedLogin?: { email: string; password: string }) {
    if (loginMethod.value === 'password') {
      if (!selectedBankAccountId.value) throw new Error('请先选择已保存密码的 ChatGPT 账号');
      const credential =
        savedLogin ?? (await bankRechargeApi.loginCredential(selectedBankAccountId.value));
      return { login: { email: credential.email, password: credential.password } };
    }
    return { sessionJson: sessionJson.value };
  }

  function acceptSession(reportInvalid = true) {
    if (formLocked.value || loginMethod.value !== 'json') return;
    importGeneration++;
    importing.value = false;
    sessionJson.value = '';
    details.value.email = '';
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
    if (formLocked.value || loginMethod.value !== 'json') return;
    importGeneration++;
    importing.value = false;
    jsonInput.value = value;
    sessionJson.value = '';
    details.value.email = '';
    if (!value.trim()) {
      jsonError.value = '';
      return;
    }
    acceptSession();
  }

  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || formLocked.value || loginMethod.value !== 'json') return;
    const generation = ++importGeneration;
    jsonInput.value = '';
    sessionJson.value = '';
    details.value.email = '';
    jsonError.value = '';
    importing.value = true;
    try {
      if (file.size > 65_000) throw new Error();
      const value = await file.text();
      if (!disposed && generation === importGeneration) {
        if (formLocked.value || loginMethod.value !== 'json') {
          jsonError.value = '任务执行中或登录方式已改变，未载入新的授权 JSON，请重新导入';
          return;
        }
        jsonInput.value = value;
        acceptSession();
      }
    } catch {
      if (!disposed && generation === importGeneration)
        jsonError.value = '文件读取失败，请选择不超过 65 KB 的 JSON 或文本文件';
    } finally {
      if (generation === importGeneration) importing.value = false;
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
    if (!canStart.value) return;
    if (!selectedAddress.value) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    const rememberPaymentSave = beginPaymentSave(id);
    let launch: V2RechargeBitBrowserLaunch | null = null;
    try {
      await nameMatch.ensureReady();
      await bankRechargeApi.checkCardAvailability(details.value.number);
      await browserSettings.checkSavedConnection();
      if (disposed) return;
      const paymentCard = await bankRechargeApi.preparePaymentCard({
        number: details.value.number,
        expiry: details.value.expiry,
        name: details.value.name,
        currencyCode: lockedCurrency.value
      });
      if (disposed) return;
      launch = await rechargeApi.startBitBrowser({
        id,
        plan: plan.value,
        addressId: selectedAddress.value.id,
        windowName: windowName.value.trim(),
        lockedCurrency: lockedCurrency.value,
        ...(selectedProxyId.value
          ? { proxyId: selectedProxyId.value, proxyCountryCode: selectedProxyCountryCode.value }
          : {}),
        cardId: paymentCard.cardId,
        billingName: details.value.name,
        expectedEmail: details.value.email,
        ...(loginMethod.value === 'password'
          ? {
              chatgptAccountId: selectedBankAccountId.value,
              useSavedCredentials: true
            }
          : {}),
        authorizeSinglePayment: true,
        manualPaymentConfirmation: true
      });
      currentId.value = id;
      rememberPaymentSave();
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
        safety: {
          lockedCurrency: launch.safety.lockedCurrency,
          authorizeSinglePayment: launch.safety.authorizeSinglePayment,
          manualPaymentConfirmation: launch.safety.manualPaymentConfirmation
        },
        ...(launch.ownedProfile ? { ownedProfile: launch.ownedProfile } : {}),
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

  async function startOpen() {
    if (!canStartOpen.value) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    let launch: V2RechargeBitBrowserOpenLaunch | null = null;
    try {
      await browserSettings.checkSavedConnection();
      if (disposed) return;
      const credential = await localCredential();
      parseDirectCredential(credential);
      if (disposed) return;
      launch = await rechargeApi.startBitBrowserOpen({
        id,
        windowName: windowName.value.trim(),
        directMode: true
      });
      currentId.value = id;
      await directOpen.start(launch, credential, windowName.value.trim());
      connectorStatus.value = 'online';
      connectorMessage.value = '网页已直连比特浏览器，登录进度见执行状态';
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
      if (launch && !directOpen.owns(id)) {
        try {
          await rechargeApi.abandonUnreceivedBitBrowser(id);
        } catch {
          error.value = '网页登录任务接收结果待核验，请刷新原任务；本次不会自动重发。';
        }
      }
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  function selectJob(id: string) {
    if (directOpen.running.value) {
      error.value =
        '当前网页仍在执行登录任务，请先完成或停止原任务，再切换执行记录；历史记录仍可在抽屉中查看。';
      return;
    }
    currentId.value = id;
    localAccess.value = null;
    const job = jobs.value.find((item) => item.id === id);
    if (job?.chatgptAccountId && loginMethod.value === 'password')
      selectedBankAccountId.value = job.chatgptAccountId;
  }

  async function recheck() {
    const source = selected.value;
    if (!canRecheck.value || !source) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    const rememberPaymentSave = beginPaymentSave(id);
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
      rememberPaymentSave();
      localAccess.value = {
        connectorUrl: launch.connectorUrl,
        connectorToken: launch.connectorToken
      };
      await rechargeConnectorApi.start(launch.connectorUrl, launch.connectorToken, {
        id,
        mode: launch.mode,
        plan: source.plan,
        ...(launch.upgradeIdentifier ? { upgradeIdentifier: launch.upgradeIdentifier } : {}),
        windowName: windowName.value.trim(),
        ...(await localCredential()),
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
      await rechargeConnectorApi.health(normalizeV2RechargeConnectorUrl(saved.connectorUrl));
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
    if (job.result.transport === 'web_direct')
      throw new Error(
        '此登录任务由原网页直连执行，请回到启动任务的网页查看；本页不会通过连接器重复操作。'
      );
    if (!localAccess.value) localAccess.value = await rechargeApi.bitBrowserAccess(job.id);
    return { job, ...localAccess.value };
  }

  async function resume() {
    if (!needsHuman.value || busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      if (selected.value && directOpen.owns(selected.value.id)) {
        // 网页直连持续核对原窗口，无连接器可恢复；下方 finally 刷新当前核对结果。
        return;
      }
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
    autoCodeController?.abort();
    try {
      if (selected.value && directOpen.owns(selected.value.id)) {
        directOpen.submitCode(selected.value.id, loginCode.value.trim());
        autoCodeSubmittedJobId.value = selected.value.id;
        loginCode.value = '';
        return;
      }
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
    const accountId = selected.value?.chatgptAccountId;
    if (!accountId || selectedBankAccountId.value !== accountId) return;
    autoCodeController?.abort();
    const controller = new AbortController();
    autoCodeController = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    const currentCodeRequest = () =>
      !disposed &&
      !signal.aborted &&
      needsCode.value &&
      selected.value?.id === jobId &&
      selected.value.chatgptAccountId === accountId &&
      selectedBankAccountId.value === accountId &&
      automaticCodeReady.value;
    autoCodeBusy.value = true;
    error.value = '';
    const releaseSkippedAttempt = () => {
      if (autoCodeSubmittedJobId.value !== jobId) autoCodeAttempted.delete(jobId);
    };
    try {
      let generated = await bankRechargeApi.totpCode(accountId, { signal });
      if (!currentCodeRequest()) {
        releaseSkippedAttempt();
        return;
      }
      if (!isV2TotpCodeCurrent(generated.token, generated.expiresAt, Date.now()))
        throw new Error('2FA 验证码已过期或格式无效，请重新取码');
      if (!isV2TotpCodeCurrent(generated.token, generated.expiresAt, Date.now() + 8000)) {
        const waitMs = Date.parse(generated.expiresAt) - Date.now() + 1000;
        generated.token = '';
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('本次自动取码已停止'));
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            Math.min(9000, Math.max(1, waitMs))
          );
          signal.addEventListener('abort', abort, { once: true });
        });
        if (!currentCodeRequest()) {
          releaseSkippedAttempt();
          return;
        }
        generated = await bankRechargeApi.totpCode(accountId, { signal });
      }
      if (!currentCodeRequest()) {
        releaseSkippedAttempt();
        return;
      }
      if (!isV2TotpCodeCurrent(generated.token, generated.expiresAt, Date.now() + 8000))
        throw new Error('2FA 验证码有效时间不足，请重新取码或在原窗口完成验证');
      if (autoCodeSubmittedJobId.value === jobId) return;
      if (directOpen.owns(jobId)) {
        directOpen.submitCode(jobId, generated.token, generated.expiresAt);
        autoCodeSubmittedJobId.value = jobId;
        await refresh();
        return;
      }
      const current = await access();
      if (current.job.id !== jobId || !currentCodeRequest()) {
        releaseSkippedAttempt();
        return;
      }
      if (autoCodeSubmittedJobId.value === jobId) return;
      if (!isV2TotpCodeCurrent(generated.token, generated.expiresAt, Date.now() + 3000))
        throw new Error('2FA 验证码有效时间不足，请重新取码');
      await rechargeConnectorApi.submitCode(
        current.connectorUrl,
        current.connectorToken,
        jobId,
        generated.token,
        generated.expiresAt,
        { signal }
      );
      autoCodeSubmittedJobId.value = jobId;
      await refresh();
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        !disposed &&
        selected.value?.id === jobId &&
        needsCode.value &&
        autoCodeSubmittedJobId.value !== jobId
      ) {
        autoCodeFailureJobId.value = jobId;
        error.value = getApiErrorMessage(cause);
      } else releaseSkippedAttempt();
    } finally {
      if (autoCodeController === controller) {
        autoCodeController = undefined;
        autoCodeBusy.value = false;
      }
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
    [
      () => (needsCode.value ? selected.value?.id : undefined),
      selectedBankAccountId,
      automaticCodeReady
    ],
    ([jobId]) => {
      autoCodeController?.abort();
      if (!jobId || disposed || !automaticCodeReady.value || autoCodeAttempted.has(jobId)) return;
      autoCodeAttempted.add(jobId);
      void submitAutomaticCode(jobId);
    },
    { flush: 'post' }
  );

  async function cancel() {
    if (!canCancel.value || busy.value || !selected.value) return;
    autoCodeController?.abort();
    busy.value = true;
    error.value = '';
    const id = selected.value.id;
    try {
      if (
        selected.value.result.mode === 'open_browser' &&
        selected.value.result.transport === 'web_direct'
      ) {
        if (directOpen.owns(id)) await directOpen.cancel(id);
        if (jobs.value.find((job) => job.id === id)?.state !== 'finished')
          await rechargeApi.cancelBitBrowser(id);
        return;
      }
      if (selected.value.action === 'server') {
        await rechargeApi.cancelServer(id);
        return;
      }
      const current = await access();
      try {
        await rechargeConnectorApi.cancel(current.connectorUrl, current.connectorToken, id);
      } catch (cause) {
        if (!(cause instanceof RechargeConnectorError) || cause.code !== 'missing') throw cause;
        await rechargeApi.abandonUnreceivedBitBrowser(id);
        if (paymentJobId.value === id) paymentJobId.value = '';
        return;
      }
      await rechargeApi.cancelBitBrowser(id);
      if (paymentJobId.value === id) paymentJobId.value = '';
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      await refresh();
      busy.value = false;
    }
  }

  watch(
    jobs,
    (items) => {
      if (!currentId.value) {
        const loginJob = items.find(
          (job) =>
            job.result.mode === 'open_browser' &&
            job.result.transport === 'web_direct' &&
            activeStates.has(job.state)
        );
        if (loginJob) currentId.value = loginJob.id;
      }
      for (const job of items) {
        if (
          job.state === 'finished' &&
          job.result.cancellation_confirmed === true &&
          directOpen.owns(job.id)
        )
          void directOpen.cancel(job.id, true).catch((cause) => {
            if (!disposed) error.value = getApiErrorMessage(cause);
          });
      }
    },
    { deep: true, immediate: true, flush: 'post' }
  );

  onScopeDispose(() => {
    disposed = true;
    autoCodeController?.abort();
    importGeneration++;
    paymentCardGeneration++;
    loginCode.value = '';
    authorizeSinglePayment.value = false;
    details.value.cvc = '';
    localAccess.value = null;
  });

  return {
    query,
    addressQuery,
    jobs,
    availableAddresses,
    selectedAddress,
    selectedAddressId,
    addressSource,
    markAddressSelectionManual,
    selected,
    active,
    jsonInput,
    sessionJson,
    jsonError,
    loginMethod,
    selectedBankAccountId,
    selectedPaymentCardId,
    selectedBankAccountEmail,
    loginCountryRestriction,
    savedBankAccounts,
    bankAccountsQuery,
    savedPaymentCards,
    paymentCardsQuery,
    paymentCardLoading,
    resettingPaymentFields,
    selectSavedCard,
    nameMatch,
    bankCurrenciesQuery,
    availableCurrencyOptions,
    loginCode,
    plan,
    windowName,
    lockedCurrency,
    selectedProxyCountryCode,
    selectedProxyId,
    availableProxyCountries,
    availableProxies,
    proxyCountriesQuery,
    proxiesQuery,
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
    resumeActionLabel,
    needsCode,
    needsManualCode,
    automaticCodeReady,
    canContinueSameAccount,
    continueSameAccount,
    autoCodeBusy,
    autoCodeMessage,
    autoCodeFailureJobId,
    autoCodeSubmittedJobId,
    workflowMessage,
    browserSettings,
    openProxySettings,
    markProxySelectionManual,
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
