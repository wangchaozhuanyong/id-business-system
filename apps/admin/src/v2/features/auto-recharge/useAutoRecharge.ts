import { computed, nextTick, onScopeDispose, reactive, ref, toRefs, watch } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import type {
  V2RechargeAddress,
  V2RechargeAddressList,
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
import { rechargeApi, rechargeConnectorApi } from './api';
import { RechargeConnectorError } from './connector-transport';
import {
  rechargeDetailsReady,
  rechargeFieldError,
  rechargeFields,
  rechargePaymentFields
} from './recharge-form';
import { useRechargeBrowserSettings, type ConnectorStatus } from './useRechargeBrowserSettings';
import { useRechargeNameMatch } from './useRechargeNameMatch';
import { useRechargeAddressGeneration } from './useRechargeAddressGeneration';
import { bankRechargeApi } from './bank-recharge-api';
import { canSelectRechargeAccount } from './recharge-account-options';
import { currencyOptions, isUnpaidCancelledRecharge } from './recharge-presentation';
import { proxyCountryCurrencies } from './recharge-proxy-options';
import { useRechargeProxyRegion } from './useRechargeProxyRegion';
import { rechargeHistoryPaymentBlocked } from './recharge-callback-diagnostics';
import { rechargeProxyApi, type RechargeProxyItem } from './recharge-proxy-api';
import { useBitBrowserDirectOpen } from './useBitBrowserDirectOpen';
import { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';
import { automaticLoginCode } from './recharge-login-code';
import { isV2TotpCodeCurrent } from '@/v2/components/workspace/totp';
import { isApiError } from '@/api/apiError';
import { directOperationDeadline, rechargeExecutionFailure } from './recharge-direct-lifecycle';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useRechargePaymentStart } from './useRechargePaymentStart';
import {
  cancelDirectPayment,
  directPaymentControls,
  ownsDirectPayment,
  startDirectPayment,
  submitDirectPaymentCode
} from './direct-payment-task';
import { accountReferenceFromJson, paymentBlockedForAccount } from './recharge-availability';

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
  directMode = true
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
  const regionPreferences = useV2SessionDraft('auto-recharge-region-preference', () => ({
    defaultCountryCode: ref('PH')
  }));
  const { defaultCountryCode } = regionPreferences;
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
    manualAddressSelectionRevision: 0,
    selectedBankAccountEmail: '',
    jsonInput: '',
    sessionJson: '',
    jsonError: '',
    plan: 'plus' as V2RechargePlan,
    selectedAddressId: '',
    addressSource: 'library' as 'library' | 'manual',
    windowName: '',
    lockedCurrency: proxyCountryCurrencies[defaultCountryCode.value] ?? 'PHP',
    selectedProxyCountryCode: defaultCountryCode.value,
    selectedProxyId: '',
    proxySelectionManual: false,
    details: emptyDetails()
  }));
  formDraft.open('new');
  // 同一标签页仍持有旧表单草稿时，只迁移入口与账号来源，不沿用旧的手填密码。
  const restored = formDraft.form as unknown as Record<string, unknown>;
  if (restored.proxySelectionManual === undefined)
    formDraft.form.proxySelectionManual = Boolean(restored.selectedProxyId);
  if (restored.operationMode === 'server_payment') formDraft.form.operationMode = 'payment';
  if (restored.loginMethod === 'saved') formDraft.form.loginMethod = 'password';
  formDraft.form.addressSource = 'library';
  delete restored.loginEmail;
  delete restored.loginPassword;
  delete restored.maxAmount;
  delete restored.selectedCardBillingAddressId;
  const {
    operationMode,
    loginMethod,
    selectedBankAccountId,
    selectedPaymentCardId,
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
    selectedProxyId,
    proxySelectionManual
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
  const connectorMessage = ref('尚未检测比特浏览器本地接口');
  const localAccess = ref<{ connectorUrl: string; connectorToken: string } | null>(null);
  let disposed = false;
  let importGeneration = 0;
  let paymentCardGeneration = 0;

  const query = useV2ModuleQuery<{
    items: V2RechargeJob[];
    configured: boolean;
    subscriptionCycleProtocol?: 1;
  }>({
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
    query: async ({ signal }) => {
      const [inventory, unused] = await Promise.all([
        rechargeApi.listAddresses({ page: 1, pageSize: 2000, status: 'all' }, { signal }),
        rechargeApi.listAddresses({ page: 1, pageSize: 2000, status: 'unused' }, { signal })
      ]);
      return {
        ...inventory,
        items: [
          ...new Map([...unused.items, ...inventory.items].map((item) => [item.id, item])).values()
        ]
      };
    }
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
    scope: 'online-recharge',
    key: () => `auto-recharge-payment-cards:${plan.value}`,
    keepPreviousData: false,
    query: ({ signal }) => bankRechargeApi.listSharedCards(plan.value, { signal })
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
  const browserSettings = useRechargeBrowserSettings(
    connectorStatus,
    connectorMessage,
    ref(false),
    ref(true)
  );
  const directTaskDisplay = ref<V2RechargeJob>();
  let directCancelling = false;
  let openStartGeneration = 0;
  let openStartPending = false;
  let clearPendingOpenCredential: (() => void) | undefined;
  let directRecheckController: AbortController | undefined;
  const directOpen = useBitBrowserDirectOpen(
    refresh,
    (message) => {
      error.value = message;
    },
    true
  );
  watch(
    sessionCoordinator.identityEpoch,
    () => {
      directTaskDisplay.value = undefined;
      directRecheckController?.abort();
      openStartGeneration++;
      clearPendingOpenCredential?.();
      clearPendingOpenCredential = undefined;
      if (openStartPending) {
        openStartPending = false;
        busy.value = false;
      }
    },
    { flush: 'sync' }
  );
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
      .filter(
        (item) =>
          item.status === 'unused' ||
          (item.status === 'used' &&
            (active.value || formLocked.value) &&
            item.id === selectedAddressId.value)
      )
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
      (item) =>
        item.active && item.hasNumber && item.allowedPlans.includes(plan.value.replace(/-/g, '_'))
    )
  );
  const proxySelectionReady = computed(
    () =>
      proxyCountriesQuery.phase.value === 'ready' &&
      !proxyCountriesQuery.error.value &&
      !proxyRegionError.value &&
      Boolean(
        selectedProxyCountryCode.value &&
        selectedProxyId.value &&
        proxiesQuery.phase.value === 'ready' &&
        !proxiesQuery.error.value &&
        !proxiesQuery.isParameterTransition.value &&
        availableProxies.value.some((item) => item.id === selectedProxyId.value)
      )
  );

  async function selectSavedCard(id: string) {
    if (disposed || busy.value || active.value) return;
    const generation = ++paymentCardGeneration;
    selectedPaymentCardId.value = id;
    paymentCardLoading.value = Boolean(id);
    if (!id) return;
    details.value.cvc = '';
    error.value = '';
    try {
      const selectedPlan = plan.value;
      const card = await bankRechargeApi.sharedCardDetail(id, selectedPlan);
      if (generation !== paymentCardGeneration || selectedPaymentCardId.value !== id || disposed)
        return;
      if (busy.value || active.value) {
        selectedPaymentCardId.value = '';
        return;
      }
      if (
        card.id !== id ||
        card.status !== 'active' ||
        plan.value !== selectedPlan ||
        !card.allowedPlans.includes(selectedPlan.replace(/-/g, '_')) ||
        !card.number ||
        !card.expiry
      ) {
        throw new Error('这张银行卡已停用、不适用当前套餐或资料不完整');
      }
      details.value.number = card.number;
      details.value.expiry = card.expiry;
      details.value.cvc = '';
      if (card.billingName) details.value.name = card.billingName;
      // 卡号监听会清除旧选择；完整资料写入后再登记本次卡号对应的编号。
      selectedPaymentCardId.value = id;
    } catch (cause) {
      if (!disposed && generation === paymentCardGeneration && selectedPaymentCardId.value === id) {
        selectedPaymentCardId.value = '';
        error.value = getApiErrorMessage(cause);
      }
    } finally {
      if (generation === paymentCardGeneration) paymentCardLoading.value = false;
    }
  }
  function markAddressSelectionManual() {
    manualAddressSelectionRevision.value++;
  }
  watch(lockedCurrency, () => {
    // 卡片支持跨币种；付款上下文变化仅清理本次临时安全码。
    details.value.cvc = '';
  });
  watch(plan, () => {
    paymentCardGeneration++;
    paymentCardLoading.value = false;
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
      ? (jobs.value.find((job) => job.id === currentId.value) ??
        (directOpen.owns(currentId.value) && directTaskDisplay.value?.id === currentId.value
          ? directTaskDisplay.value
          : undefined))
      : (jobs.value.find((job) => activeStates.has(job.state)) ??
        jobs.value.find((job) => job.state === 'unknown' && job.result.payment_attempted === true))
  );
  const active = computed(() => jobs.value.some((job) => activeStates.has(job.state)));
  const currentSettingsReady = computed(() =>
    settingsReady(
      settingsQuery.data.value,
      operationMode.value === 'payment' && Boolean(selectedProxyId.value),
      true
    )
  );
  const formLocked = computed(
    () =>
      busy.value ||
      resettingPaymentFields.value ||
      paymentCardLoading.value ||
      Boolean(paymentJobId.value && !jobs.value.some((job) => job.id === paymentJobId.value))
  );
  const proxyRegionLocked = computed(() => formLocked.value || active.value);
  const proxyRegion = useRechargeProxyRegion({
    currency: lockedCurrency,
    country: selectedProxyCountryCode,
    proxyId: selectedProxyId,
    defaultCountry: defaultCountryCode,
    manualSelection: proxySelectionManual,
    currencies: availableCurrencyOptions,
    countries: computed(() => proxyCountriesQuery.data.value?.items ?? []),
    locked: proxyRegionLocked,
    query: proxiesQuery
  });
  const {
    countries: availableProxyCountries,
    defaultCountries: defaultCountryOptions,
    proxies: availableProxies,
    countryCurrencyError: proxyRegionError,
    note: proxySelectionNote,
    markManual: markProxySelectionManual
  } = proxyRegion;
  const currentAccountReference = ref<string>();
  let accountReferenceGeneration = 0;
  watch(
    sessionJson,
    async (raw) => {
      const generation = ++accountReferenceGeneration;
      currentAccountReference.value = undefined;
      const reference = await accountReferenceFromJson(raw);
      if (!disposed && generation === accountReferenceGeneration)
        currentAccountReference.value = reference;
    },
    { immediate: true }
  );
  const paymentRetryBlocked = computed(() =>
    jobs.value.some((job) =>
      paymentBlockedForAccount(job, {
        reference: loginMethod.value === 'json' ? currentAccountReference.value : undefined,
        savedId: loginMethod.value === 'password' ? selectedBankAccountId.value : undefined
      })
    )
  );
  const credentialReady = computed(() =>
    loginMethod.value === 'json'
      ? Boolean(sessionJson.value && !importing.value && !jsonError.value)
      : Boolean(selectedBankAccount.value && selectedBankAccountEmail.value)
  );
  const automaticCodeReady = computed(
    () =>
      loginMethod.value === 'password' &&
      selected.value?.chatgptAccountId === selectedBankAccountId.value &&
      (selected.value?.result.login_code_type === 'email' ||
        Boolean(selectedBankAccount.value?.hasTotp))
  );
  const nameMatch = useRechargeNameMatch(
    details,
    ref(''),
    computed(() => formLocked.value || active.value || operationMode.value !== 'payment')
  );
  const canGenerateAddress = computed(
    () =>
      operationMode.value === 'payment' &&
      !formLocked.value &&
      !active.value &&
      !nameMatch.loading.value &&
      !nameMatch.error.value
  );
  const addressGeneration = useRechargeAddressGeneration({
    allowed: canGenerateAddress,
    automatic: computed(
      () =>
        canGenerateAddress.value &&
        addressQuery.phase.value === 'ready' &&
        !addressQuery.error.value &&
        Boolean(details.value.name) &&
        !rechargeFieldError('number', details.value.number) &&
        availableAddresses.value.length === 0
    ),
    context: () => [
      details.value.number.replace(/[ -]/g, ''),
      selectedPaymentCardId.value,
      manualAddressSelectionRevision.value,
      operationMode.value,
      formLocked.value,
      active.value,
      sessionCoordinator.identityEpoch.value
    ],
    addresses: availableAddresses,
    refresh: () => addressQuery.refresh(),
    select: (id) => {
      addressSource.value = 'library';
      selectedAddressId.value = id;
    }
  });
  function generateBillingAddress() {
    return addressGeneration.generate();
  }
  // 姓名库返回的是比特历史卡编号，共享池选择必须保留自己的编号。
  watch(
    () => details.value.number.replace(/[ -]/g, ''),
    () => {
      selectedPaymentCardId.value = '';
    },
    { flush: 'sync' }
  );
  let paymentEditVersion = 0;
  watch(
    [
      operationMode,
      loginMethod,
      selectedBankAccountId,
      selectedPaymentCardId,
      selectedAddressId,
      addressSource,
      manualAddressSelectionRevision,
      plan,
      windowName,
      lockedCurrency,
      selectedProxyCountryCode,
      selectedProxyId,
      authorizeSinglePayment,
      sessionJson,
      () => details.value.number,
      () => details.value.expiry,
      () => details.value.cvc,
      () => details.value.name,
      () => details.value.email,
      () => details.value.country,
      () => details.value.line1,
      () => details.value.line2,
      () => details.value.city,
      () => details.value.state,
      () => details.value.postal_code
    ],
    () => {
      if (!nameMatch.applying.value) paymentEditVersion++;
    },
    { flush: 'sync' }
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
        !addressGeneration.generating.value &&
        authorizeSinglePayment.value &&
        rechargeDetailsReady(details.value) &&
        currentSettingsReady.value
      ) &&
      !formLocked.value &&
      !active.value &&
      !directOpen.running.value &&
      !directPaymentControls.size &&
      !paymentRetryBlocked.value &&
      query.phase.value === 'ready'
  );
  const canStartOpen = computed(
    () =>
      Boolean(credentialReady.value && windowName.value.trim() && currentSettingsReady.value) &&
      !formLocked.value &&
      !active.value &&
      !directOpen.running.value &&
      !directPaymentControls.size &&
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
  function recheckAllowed(job: V2RechargeJob | undefined) {
    if (!job) return false;
    return Boolean(
      job.action === 'bitbrowser' &&
      ['finished', 'unknown'].includes(job.state) &&
      (job.result.payment_attempted === true ||
        Number(job.result.payment_requests_sent ?? 0) === 1) &&
      job.result.recheck_only !== true &&
      !job.result.operator_resolution &&
      !job.result.manual_settlement &&
      job.result.status !== 'subscription_activated' &&
      job.result.payment_outcome !== 'subscription_activated' &&
      credentialReady.value &&
      windowName.value.trim() &&
      settingsReady(settingsQuery.data.value) &&
      !busy.value &&
      !active.value &&
      query.phase.value === 'ready'
    );
  }
  const canRecheck = computed(() => recheckAllowed(selected.value));
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
      !job.result.operator_resolution &&
      !job.result.manual_settlement &&
      job.result.resolution_verification_job_id &&
      !busy.value &&
      !active.value &&
      query.phase.value === 'ready'
    );
  });
  const needsCode = computed(
    () =>
      selected.value?.state === 'awaiting_human_verification' &&
      selected.value?.action === 'bitbrowser' &&
      ['login_code_required', 'login_email_code_required'].includes(
        String(selected.value.result.stage)
      ) &&
      (selected.value.result.transport !== 'web_direct' ||
        directOpen.owns(selected.value.id) ||
        ownsDirectPayment(selected.value.id))
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
        ? '正在自动读取并提交验证码…'
        : '正在等待自动取码…'
  );
  const needsHuman = computed(
    () =>
      selected.value?.action === 'bitbrowser' &&
      selected.value.state === 'awaiting_human_verification' &&
      selected.value.result.stage !== 'next_subscription_cycle_review' &&
      selected.value.result.cycle_review?.status !== 'awaiting_previous_cycle_confirmation' &&
      !needsCode.value &&
      (selected.value.result.transport !== 'web_direct' ||
        directOpen.owns(selected.value.id) ||
        ownsDirectPayment(selected.value.id))
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
      !directOpen.owns(job.id) &&
      !ownsDirectPayment(job.id)
    )
      return '此任务由原网页直连执行。本页可停止任务并解锁资料；继续核对需回到原网页。';
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
    if (job?.result.stage === 'next_subscription_cycle_review')
      return job.result.cycle_review?.status === 'awaiting_previous_cycle_confirmation'
        ? '当前只读核实旧订阅周期，请在下方核实旧周期已经结束；后续付款仍须单独确认官网报价。'
        : '正在只读核实旧订阅周期与当前订阅，请查看下方核实状态；本次尚未授权付款。';
    if (job?.state === 'awaiting_human_verification')
      return '比特浏览器正在等待人工验证；完成官网或银行验证后点击继续。';
    if (job?.state === 'running' && job.result.transport === 'web_direct')
      return '网页正在连接比特浏览器并核实官网状态，请保留当前管理页面。';
    if (job?.state === 'running')
      return job.action === 'server'
        ? '服务器正在执行，本任务最多提交一次付款。'
        : '本机比特浏览器正在执行，系统不会重复提交付款。';
    const targetFamily =
      job?.plan === 'plus'
        ? 'plus'
        : job?.plan === 'pro-500'
          ? 'promax'
          : job && ['pro-5x', 'pro-20x'].includes(job.plan)
            ? 'pro'
            : undefined;
    if (
      job &&
      ['unknown', 'finished'].includes(job.state) &&
      job.result.operation === 'subscription_upgrade' &&
      job.result.account_matched === true &&
      job.result.payment_attempted === true &&
      job.result.payment_status === 'unknown' &&
      !job.result.payment_evidence &&
      job.result.subscription_status === job.plan &&
      targetFamily &&
      job.result.current_plan === targetFamily
    )
      return '套餐已核实生效，付款凭据待核验；请只读复查原订单，禁止重新付款。';
    if (job?.state === 'unknown')
      return paymentRetryBlocked.value
        ? '本账号原单结果待核验，禁止重新付款；可仅登录、只读查单或处理其他账号。'
        : '原任务执行租约已结束，不继续占执行名额；付款风险按当前账号单独核对。';
    if (job?.state === 'finished') {
      if (
        job.result.operator_resolution === 'confirmed_verification_failed_no_charge' &&
        job.availability?.payment === 'resolved'
      )
        return '验证失败原单已由本人核实处理，原任务和付款次数已保留；可重新核价并确认下一笔充值。';
      if (rechargeHistoryPaymentBlocked(job))
        return '历史付款或订阅结果待核实，本次充值已暂停；请查看最近执行记录并只读复查原订单，填写资料已保留。';
      if (job.result.mode === 'open_browser') {
        return job.result.status === 'session_ready' && job.result.account_matched
          ? '账号登录成功，比特浏览器窗口已打开，可进行手动操作。'
          : '本次登录已停止，请查看具体原因并检查原窗口。';
      }
      if (job.result.status === 'already_subscribed')
        return '官网已核实该账号已是目标套餐，本次未提交付款。';
      if (job.result.status === 'subscription_activated')
        return '付款与套餐生效均已核实；可继续为同一账号选择下一套餐。';
      if (isUnpaidCancelledRecharge(job) && !paymentRetryBlocked.value)
        return '本次任务已停止，未提交付款；填写资料已保留。';
      if (
        job.result.payment_status === 'unknown' &&
        (job.result.payment_attempted === true || Number(job.result.payment_requests_sent) > 0)
      )
        return '本次付款已有提交记录，请只读复查原订单；填写资料已保留。';
      return paymentRetryBlocked.value
        ? '本次付款已有提交记录，请只读复查原订单；填写资料已保留。'
        : '本次充值未成功，填写资料已保留；修正原因后可再次执行。';
    }
    if (!currentSettingsReady.value) return '请先完成当前电脑的比特浏览器直连设置。';
    if (!credentialReady.value)
      return loginMethod.value === 'json'
        ? '粘贴授权 JSON 后会自动载入账号邮箱。'
        : '请从 ChatGPT 账号资料中选择已保存登录密码的账号。';
    if (operationMode.value === 'open_browser')
      return '核对窗口名称后，点击即可打开比特浏览器并自动登录。';
    if (paymentRetryBlocked.value)
      return '本账号存在待核实的历史付款，暂不能发起新充值；请在“最近执行记录”只读复查原单。仅登录和其他账号仍可操作。';
    if (nameMatch.loading.value) return '正在填写银行卡账单姓名，请稍候。';
    if (nameMatch.error.value) return '账单姓名匹配失败，请在账单姓名处重试。';
    if (addressGeneration.generating.value) return '正在生成并填写账单地址，请稍候。';
    if (addressGeneration.error.value && !selectedAddress.value)
      return addressGeneration.error.value;
    const fieldErrors = rechargeFields.flatMap((field) => {
      const cardField = rechargePaymentFields.includes(field);
      const addressField = !cardField && field.key !== 'name' && field.key !== 'email';
      if (addressField && !selectedAddress.value) return [];
      const message = rechargeFieldError(field.key, details.value[field.key]);
      return message ? [addressField ? `账单地址：${message}` : message] : [];
    });
    if (!selectedAddress.value) fieldErrors.push('请选择可用的账单地址');
    if (fieldErrors.length) return `请修正以下资料：${fieldErrors.join('；')}。`;
    if (!authorizeSinglePayment.value)
      return '银行卡与账单地址已通过校验，请勾选本次单次付款授权。';
    if (!windowName.value.trim()) return '银行卡与账单地址已通过校验，请填写窗口名称。';
    if (
      !/^[A-Z]{3}$/.test(lockedCurrency.value) ||
      !availableCurrencyOptions.value.some((item) => item.value === lockedCurrency.value)
    )
      return '银行卡与账单地址已通过校验，请选择可用的锁定币种。';
    if (!proxySelectionReady.value || loginCountryRestriction.value)
      return (
        proxyRegionError.value ||
        proxySelectionNote.value ||
        '银行卡与账单地址已通过校验，请核对代理国家与可用的代理 IP。'
      );
    return canStart.value
      ? '资料已就绪，点击“在比特浏览器执行”核实官网币种和金额后，等待你确认本次付款。'
      : '银行卡与账单地址已通过校验，正在确认任务状态，请稍候。';
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
        address = availableAddresses.value[0];
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
          result.manual_settlement ||
          result.payment_status === 'declined' ||
          result.operator_resolution === 'confirmed_no_bank_request' ||
          (result.operator_resolution === 'confirmed_verification_failed_no_charge' &&
            paymentJob.availability?.payment === 'resolved')
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
      if (!selectedBankAccountId.value) throw new Error('请先选择 ChatGPT 账号');
      const credential =
        savedLogin ?? (await bankRechargeApi.loginCredential(selectedBankAccountId.value));
      return { login: { email: credential.email, password: credential.password } };
    }
    return { sessionJson: sessionJson.value };
  }

  function acceptSession(reportInvalid = true, previousEmail = details.value.email) {
    if (formLocked.value || loginMethod.value !== 'json') return;
    importGeneration++;
    importing.value = false;
    sessionJson.value = '';
    details.value.email = '';
    if (!jsonInput.value.trim()) {
      if (reportInvalid) jsonError.value = '请粘贴完整的单账户授权 JSON';
      return;
    }
    if (new TextEncoder().encode(jsonInput.value).length > 65_000) {
      if (reportInvalid) jsonError.value = '授权 JSON 超过 65 KB，请提供单账户授权文件';
      return;
    }
    try {
      const value = JSON.parse(jsonInput.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const email = registrationEmail(value);
      if (!email) {
        jsonError.value = '授权 JSON 中未找到唯一有效的 ChatGPT 注册邮箱';
        return;
      }
      sessionJson.value = jsonInput.value;
      details.value.email = email;
      if (
        !windowName.value.trim() ||
        (previousEmail && windowName.value === `ChatGPT-${previousEmail.split('@')[0]}`)
      ) {
        const prefix = email.split('@')[0] || 'account';
        windowName.value = `ChatGPT-${prefix}`;
      }
      jsonInput.value = '';
      jsonError.value = '';
    } catch {
      if (reportInvalid) jsonError.value = '授权 JSON 格式不完整或无效，请重新复制完整的单账户授权';
    }
  }

  function updateJsonInput(value: string) {
    if (formLocked.value || loginMethod.value !== 'json') return;
    const previousEmail = details.value.email;
    importGeneration++;
    importing.value = false;
    jsonInput.value = value;
    sessionJson.value = '';
    details.value.email = '';
    if (!value.trim()) {
      jsonError.value = '';
      return;
    }
    acceptSession(true, previousEmail);
  }

  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || formLocked.value || loginMethod.value !== 'json') return;
    const previousEmail = details.value.email;
    const generation = ++importGeneration;
    jsonInput.value = '';
    sessionJson.value = '';
    details.value.email = '';
    jsonError.value = '';
    importing.value = true;
    try {
      if (file.size > 65_000) {
        jsonError.value = '授权文件超过 65 KB，请选择单账户授权文件';
        return;
      }
      const value = await file.text();
      if (!disposed && generation === importGeneration) {
        if (formLocked.value || loginMethod.value !== 'json') {
          jsonError.value = '任务执行中或登录方式已改变，未载入新的授权 JSON，请重新导入';
          return;
        }
        jsonInput.value = value;
        acceptSession(true, previousEmail);
      }
    } catch {
      if (!disposed && generation === importGeneration)
        jsonError.value = '文件读取失败，请重新选择 JSON 或文本文件';
    } finally {
      if (generation === importGeneration) importing.value = false;
      input.value = '';
    }
  }

  let refreshing: Promise<void> | undefined;
  let refreshQueued = false;
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshing) {
      refreshQueued = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshQueued = false;
        try {
          await query.refresh();
        } catch {
          /* 读取失败由异步区域展示，不取消执行或覆盖业务错误。 */
        }
      } while (refreshQueued && !disposed);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  const connectionVersion = () => JSON.stringify(settingsQuery.data.value ?? null);
  const { start } = useRechargePaymentStart({
    canStart,
    busy,
    error,
    currentId,
    connectorStatus,
    connectorMessage,
    localAccess,
    apiProtocol: () => query.data.value?.subscriptionCycleProtocol,
    connectionVersion,
    editVersion: () => paymentEditVersion,
    verifiedDetails: () =>
      selectedAddress.value
        ? {
            name: details.value.name,
            addressId: selectedAddress.value.id,
            cardId: selectedPaymentCardId.value
          }
        : undefined,
    ensureNameReady: () => nameMatch.ensureReady(),
    checkSavedConnection: (current) => browserSettings.checkSavedConnection(current),
    beginPaymentSave,
    refresh,
    snapshot: () => {
      if (!selectedAddress.value) return undefined;
      return {
        connectionVersion: connectionVersion(),
        input: {
          connectionProfileId: settingsQuery.data.value?.connectionProfileId ?? null,
          plan: plan.value,
          addressId: selectedAddress.value.id,
          windowName: windowName.value.trim(),
          lockedCurrency: lockedCurrency.value,
          ...(selectedProxyId.value
            ? { proxyId: selectedProxyId.value, proxyCountryCode: selectedProxyCountryCode.value }
            : {}),
          billingName: details.value.name,
          expectedEmail: details.value.email,
          ...(loginMethod.value === 'password'
            ? { chatgptAccountId: selectedBankAccountId.value, useSavedCredentials: true }
            : {}),
          authorizeSinglePayment: true,
          manualPaymentConfirmation: true
        },
        payment: {
          number: details.value.number,
          expiry: details.value.expiry,
          cvc: details.value.cvc,
          name: details.value.name,
          email: details.value.email
        },
        credential:
          loginMethod.value === 'password'
            ? { login: { email: details.value.email, password: '' } }
            : { sessionJson: sessionJson.value }
      };
    }
  });

  async function startOpen() {
    if (!canStartOpen.value) return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    const identityEpoch = sessionCoordinator.identityEpoch.value;
    const generation = ++openStartGeneration;
    openStartPending = true;
    const identityCurrent = () => identityEpoch === sessionCoordinator.identityEpoch.value;
    const current = () => !disposed && identityCurrent() && generation === openStartGeneration;
    let launch: V2RechargeBitBrowserOpenLaunch | null = null;
    let credential: DirectLoginCredential | undefined;
    const clearCredential = () => {
      if (credential?.login) credential.login.password = '';
      if (credential && 'sessionJson' in credential) credential.sessionJson = '';
    };
    const releaseUnreceived = async (unreceived: V2RechargeBitBrowserOpenLaunch) => {
      try {
        if (identityCurrent()) await rechargeApi.abandonUnreceivedBitBrowser(id);
        else
          await directOperationDeadline(
            (signal) =>
              rechargeApi.directBrowserCallback(
                id,
                unreceived.agentToken,
                {
                  type: 'finished',
                  result: {
                    status: 'cancelled',
                    stage: 'connector_dispatch',
                    reason: 'bitbrowser_direct_cancelled',
                    cancellation_confirmed: true,
                    payment_attempted: false,
                    payment_requests_sent: 0
                  }
                },
                { signal }
              ),
            15_000
          );
        return true;
      } catch {
        return false;
      }
    };
    try {
      await browserSettings.checkSavedConnection(current);
      if (!current()) return;
      credential = await localCredential();
      if (!current()) return;
      clearPendingOpenCredential = clearCredential;
      parseDirectCredential(credential);
      if (!current()) return;
      launch = await rechargeApi.startBitBrowserOpen({
        id,
        connectionProfileId: settingsQuery.data.value?.connectionProfileId ?? null,
        windowName: windowName.value.trim(),
        directMode: true,
        ...(loginMethod.value === 'password'
          ? { chatgptAccountId: selectedBankAccountId.value }
          : {})
      });
      if (!current()) {
        clearCredential();
        await releaseUnreceived(launch);
        return;
      }
      currentId.value = id;
      if (current()) {
        const now = new Date().toISOString();
        // 只展示当前网页已接管的登录任务，不覆盖服务端读取结果或保留敏感资料。
        directTaskDisplay.value = {
          id,
          action: 'bitbrowser',
          state: 'running',
          plan: plan.value,
          result: {
            mode: 'open_browser',
            transport: 'web_direct',
            status: 'running',
            stage: 'bitbrowser_group',
            payment_attempted: false,
            payment_requests_sent: 0
          },
          createdAt: now,
          updatedAt: now
        };
      }
      const starting = directOpen.start(
        launch,
        credential,
        windowName.value.trim(),
        identityEpoch,
        loginMethod.value === 'password' ? selectedBankAccountId.value : undefined
      );
      if (clearPendingOpenCredential === clearCredential) clearPendingOpenCredential = undefined;
      if (directOpen.owns(id)) busy.value = false;
      await starting;
      if (!current()) return;
      connectorStatus.value = 'online';
      connectorMessage.value = '网页已直连比特浏览器，登录进度见执行状态';
    } catch (cause) {
      if (current() && !error.value)
        error.value = isApiError(cause)
          ? rechargeExecutionFailure(cause)
          : getApiErrorMessage(cause);
      if (launch && !directOpen.handles?.(id)) {
        const released = await releaseUnreceived(launch);
        if (!released && current()) {
          error.value += ' 登录任务结束结果待核验，请刷新原任务；本次不会自动重发。';
        }
      }
    } finally {
      if (!directOpen.handles?.(id)) {
        clearCredential();
        if (launch) {
          launch.agentToken = '';
          launch.connectorToken = '';
          launch.bitBrowser.localApiToken = '';
          launch.bitBrowser.dynamicProxyUrl = '';
          if (launch.bitBrowser.staticProxyCredentials)
            launch.bitBrowser.staticProxyCredentials.password = '';
        }
      }
      if (clearPendingOpenCredential === clearCredential) clearPendingOpenCredential = undefined;
      if (current()) {
        openStartPending = false;
        if (!directCancelling) busy.value = false;
        void refresh();
      }
    }
  }

  function selectJob(id: string) {
    if (directOpen.running.value || directPaymentControls.size) {
      error.value =
        '当前网页仍在执行任务，请先完成或停止原任务，再切换执行记录；历史记录仍可在抽屉中查看。';
      return;
    }
    currentId.value = id;
    localAccess.value = null;
  }

  async function recheck(source: V2RechargeJob | undefined = selected.value) {
    if (!source || !recheckAllowed(source)) return;
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
        directMode: true,
        connectionProfileId: settingsQuery.data.value?.connectionProfileId ?? null,
        sourceJobId: source.id,
        plan: source.plan,
        windowName: windowName.value.trim()
      });
      currentId.value = id;
      rememberPaymentSave();
      {
        if (launch.transport !== 'web_direct')
          throw new Error('网页只读复查协议未就绪，请更新网站后重试。');
        localAccess.value = null;
        await startDirectPayment({
          launch,
          plan: source.plan,
          credential: await localCredential(),
          payment: { ...emptyDetails(), cvc: '' },
          recheck: source.result,
          windowName: windowName.value.trim(),
          accountId: loginMethod.value === 'password' ? selectedBankAccountId.value : undefined,
          signal: (directRecheckController = new AbortController()).signal,
          refresh,
          reportError: (message) => {
            if (!disposed) error.value = message;
          }
        });
        connectorStatus.value = 'online';
        connectorMessage.value = '网页已开始只读复查原单';
        return;
      }
    } catch (cause) {
      if (launch?.transport === 'web_direct')
        await rechargeApi.abandonUnreceivedBitBrowser(id).catch(() => undefined);
      error.value = launch
        ? '原单只读复查接收结果待核实，本次不会新建订单或重复付款。'
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
    try {
      if (disposed) return;
      const response = await rechargeApi.resolveNoBankRequest(source.id, {
        directMode: true,
        confirmNoBankRequest: true,
        verificationJobId
      });
      if (isAlreadyResolved(response)) {
        connectorMessage.value = '历史付款记录已经处理';
        return;
      }
      throw new Error('网页历史记录处理协议未就绪，请刷新网站后核实原任务。');
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
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
        '此任务由原网页直连执行，请回到启动任务的网页查看；本页不会通过连接器重复操作。'
      );
    if (!localAccess.value) localAccess.value = await rechargeApi.bitBrowserAccess(job.id);
    return { job, ...localAccess.value };
  }

  async function resume() {
    if (!needsHuman.value || busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      if (selected.value && ownsDirectPayment(selected.value.id)) return;
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
      if (selected.value && ownsDirectPayment(selected.value.id)) {
        submitDirectPaymentCode(selected.value.id, loginCode.value.trim());
        loginCode.value = '';
        return;
      }
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
        loginCode.value.trim(),
        undefined,
        {
          kind: current.job.result.login_code_type,
          challengeId: current.job.result.login_challenge_id
        }
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]);
    const currentCodeRequest = () =>
      !disposed &&
      !signal.aborted &&
      needsCode.value &&
      selected.value?.id === jobId &&
      selected.value.chatgptAccountId === accountId &&
      selectedBankAccountId.value === accountId &&
      automaticCodeReady.value &&
      selected.value?.result.login_challenge_id === challengeIdAtStart;
    const challengeIdAtStart = selected.value?.result.login_challenge_id;
    autoCodeBusy.value = true;
    error.value = '';
    const releaseSkippedAttempt = () => {
      if (autoCodeSubmittedJobId.value !== jobId) autoCodeAttempted.delete(jobId);
    };
    try {
      const kind = selected.value?.result.login_code_type;
      const challengeId = selected.value?.result.login_challenge_id;
      if ((kind !== 'email' && kind !== 'totp') || !challengeId)
        throw new Error('原窗口尚未提供明确的验证码类型，请在原窗口核对');
      const generated = await automaticLoginCode(jobId, accountId, { kind, challengeId }, signal);
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
        { signal, kind, challengeId }
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
      automaticCodeReady,
      () => selected.value?.result.login_challenge_id
    ],
    ([jobId]) => {
      autoCodeController?.abort();
      if (
        !jobId ||
        disposed ||
        directOpen.owns(jobId) ||
        ownsDirectPayment(jobId) ||
        !automaticCodeReady.value
      )
        return;
      const attempt = `${jobId}:${selected.value?.result.login_challenge_id ?? ''}`;
      if (autoCodeAttempted.has(attempt)) return;
      autoCodeAttempted.add(attempt);
      autoCodeSubmittedJobId.value = '';
      autoCodeFailureJobId.value = '';
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
    directCancelling = directOpen.owns(id);
    try {
      if (
        selected.value.result.transport === 'web_direct' &&
        selected.value.result.mode !== 'open_browser'
      ) {
        await cancelDirectPayment(id);
        return;
      }
      if (
        selected.value.result.mode === 'open_browser' &&
        selected.value.result.transport === 'web_direct'
      ) {
        if (directOpen.owns(id)) {
          await directOpen.cancel(id);
          return;
        }
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
      directCancelling = false;
      busy.value = false;
      void refresh();
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
    directRecheckController?.abort();
    autoCodeController?.abort();
    importGeneration++;
    paymentCardGeneration++;
    loginCode.value = '';
    authorizeSinglePayment.value = false;
    details.value.cvc = '';
    localAccess.value = null;
    directTaskDisplay.value = undefined;
    openStartGeneration++;
    openStartPending = false;
    clearPendingOpenCredential?.();
    clearPendingOpenCredential = undefined;
  });

  return {
    query,
    addressQuery,
    addressGeneration,
    canGenerateAddress,
    generateBillingAddress,
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
    defaultCountryCode,
    defaultCountryOptions,
    proxyRegionLocked,
    proxyRegionError,
    proxySelectionNote,
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
