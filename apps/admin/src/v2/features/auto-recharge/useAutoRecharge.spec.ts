import { effectScope, nextTick, ref, type Ref } from 'vue';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  V2RechargeAddress,
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserResolutionLaunch,
  V2RechargeBitBrowserSettings,
  V2RechargeJob
} from './contracts';
import type { BankChatgptAccount } from './bank-recharge-api';
import type { RechargeProxyItem } from './recharge-proxy-api';
import { useAutoRecharge } from './useAutoRecharge';
import { clearV2SessionDrafts, useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { DirectBrowserError } from './bitbrowser-direct-api';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

const mock = vi.hoisted(() => ({
  jobsQuery: {} as Record<string, unknown>,
  addressesQuery: {} as Record<string, unknown>,
  settingsQuery: {} as Record<string, unknown>,
  serverProxySettingsQuery: {} as Record<string, unknown>,
  defaultProxyCatalogQuery: {} as Record<string, unknown>,
  totpQuery: {} as Record<string, unknown>,
  bankAccountsQuery: {} as Record<string, unknown>,
  bankCurrenciesQuery: {} as Record<string, unknown>,
  paymentCardsQuery: {} as Record<string, unknown>,
  proxyCountriesQuery: {} as Record<string, unknown>,
  proxiesQuery: {} as Record<string, unknown>,
  checkCardAvailability: vi.fn(),
  matchCardName: vi.fn(),
  generateAddresses: vi.fn(),
  preparePaymentCard: vi.fn(),
  managedCardDetail: vi.fn(),
  accountIdentity: vi.fn(),
  loginCredential: vi.fn(),
  accountTotpCode: vi.fn(),
  automaticLoginCode: vi.fn(),
  clearPaymentValidation: vi.fn(),
  queryIndex: 0,
  jobOptions: undefined as
    | undefined
    | {
        getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
      },
  startBitBrowser: vi.fn(),
  startServer: vi.fn(),
  recheckServer: vi.fn(),
  cancelServer: vi.fn(),
  startBitBrowserOpen: vi.fn(),
  directBrowserCallback: vi.fn(),
  recheckBitBrowser: vi.fn(),
  resolveNoBankRequest: vi.fn(),
  cancelBitBrowser: vi.fn(),
  abandonUnreceivedBitBrowser: vi.fn(),
  bitBrowserAccess: vi.fn(),
  updateBitBrowserSettings: vi.fn(),
  updateServerProxySettings: vi.fn(),
  connectorStart: vi.fn(),
  connectorStatus: vi.fn(),
  connectorResume: vi.fn(),
  connectorSubmitCode: vi.fn(),
  listTotpAccounts: vi.fn(),
  connectorCancel: vi.fn(),
  connectorHealth: vi.fn(),
  connectorCatalog: vi.fn(),
  directCatalog: vi.fn(),
  directStart: vi.fn(),
  directRunning: undefined as Ref<boolean> | undefined,
  directOwns: vi.fn(),
  directHandles: vi.fn(),
  directSubmitCode: vi.fn(),
  directCancel: vi.fn(),
  startDirectPayment: vi.fn(),
  paymentControls: new Map<string, Record<string, unknown>>(),
  paymentOwns: vi.fn(),
  paymentCancel: vi.fn(),
  paymentSubmitCode: vi.fn(),
  callbackUrl: vi.fn((id: string) => `https://admin.example/api/local/${id}`),
  confirmResolution: vi.fn()
}));

vi.mock('./recharge-login-code', () => ({ automaticLoginCode: mock.automaticLoginCode }));
vi.mock('./direct-payment-task', async () => {
  const { shallowReactive } = await import('vue');
  mock.paymentControls = shallowReactive(mock.paymentControls);
  return {
    startDirectPayment: mock.startDirectPayment,
    directPaymentControls: mock.paymentControls,
    ownsDirectPayment: mock.paymentOwns,
    cancelDirectPayment: mock.paymentCancel,
    submitDirectPaymentCode: mock.paymentSubmitCode
  };
});

vi.mock('./bitbrowser-direct-api', async (original) => ({
  ...(await original<typeof import('./bitbrowser-direct-api')>()),
  directBrowserCatalog: mock.directCatalog
}));
vi.mock('./useBitBrowserDirectOpen', () => ({
  useBitBrowserDirectOpen: () => ({
    start: mock.directStart,
    owns: mock.directOwns,
    handles: mock.directHandles,
    running: mock.directRunning ?? ref(false),
    submitCode: mock.directSubmitCode,
    cancel: mock.directCancel
  })
}));

vi.mock('element-plus/es/components/message-box/index.mjs', () => ({
  ElMessageBox: { confirm: mock.confirmResolution }
}));

vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: (options: {
    moduleKey: string;
    key?: string;
    getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
  }) => {
    if (options.moduleKey === 'auto-recharge-addresses') return mock.addressesQuery;
    if (options.key === 'auto-recharge-server-proxy-settings') return mock.serverProxySettingsQuery;
    if (options.key === 'auto-recharge-default-proxy-catalog') return mock.defaultProxyCatalogQuery;
    if (options.key === 'auto-recharge-saved-totp-accounts') return mock.totpQuery;
    if (options.moduleKey === 'chatgpt-accounts') return mock.bankAccountsQuery;
    if (options.moduleKey === 'bank-recharge-orders') return mock.bankCurrenciesQuery;
    if (options.moduleKey === 'bank-recharge-cards') return mock.paymentCardsQuery;
    if (options.moduleKey === 'recharge-proxies')
      return options.key === 'auto-recharge-proxy-countries'
        ? mock.proxyCountriesQuery
        : mock.proxiesQuery;
    const result = mock.queryIndex++ === 0 ? mock.jobsQuery : mock.settingsQuery;
    if (options.getRevalidateAt) mock.jobOptions = options;
    return result;
  }
}));

vi.mock('./api', () => ({
  rechargeTotpApi: { listSavedAccounts: mock.listTotpAccounts },
  rechargeCallbackUrl: mock.callbackUrl,
  rechargeApi: {
    list: vi.fn(),
    listAddresses: vi.fn(),
    generateAddresses: mock.generateAddresses,
    getBitBrowserSettings: vi.fn(),
    getServerProxySettings: vi.fn(),
    updateServerProxySettings: mock.updateServerProxySettings,
    startBitBrowser: mock.startBitBrowser,
    startServer: mock.startServer,
    recheckServer: mock.recheckServer,
    cancelServer: mock.cancelServer,
    startBitBrowserOpen: mock.startBitBrowserOpen,
    directBrowserCallback: mock.directBrowserCallback,
    recheckBitBrowser: mock.recheckBitBrowser,
    resolveNoBankRequest: mock.resolveNoBankRequest,
    cancelBitBrowser: mock.cancelBitBrowser,
    abandonUnreceivedBitBrowser: mock.abandonUnreceivedBitBrowser,
    bitBrowserAccess: mock.bitBrowserAccess,
    updateBitBrowserSettings: mock.updateBitBrowserSettings
  },
  rechargeConnectorApi: {
    start: mock.connectorStart,
    status: mock.connectorStatus,
    resume: mock.connectorResume,
    submitCode: mock.connectorSubmitCode,
    cancel: mock.connectorCancel,
    health: mock.connectorHealth
  }
}));

vi.mock('@/api/client', () => ({ getApiErrorMessage: (cause: Error) => cause.message }));
vi.mock('./bank-recharge-api', () => ({
  bankRechargeApi: {
    checkCardAvailability: mock.checkCardAvailability,
    matchCardName: mock.matchCardName,
    preparePaymentCard: mock.preparePaymentCard,
    listCards: vi.fn(),
    listSharedCards: vi.fn(),
    sharedCardDetail: mock.managedCardDetail,
    listAccounts: vi.fn(),
    listCurrencies: vi.fn(),
    managedCardDetail: mock.managedCardDetail,
    accountIdentity: mock.accountIdentity,
    loginCredential: mock.loginCredential,
    totpCode: mock.accountTotpCode
  }
}));
vi.mock('./recharge-proxy-api', () => ({
  rechargeProxyApi: { countries: vi.fn(), list: vi.fn() }
}));
vi.mock('./useRechargeBrowserCatalog', () => ({
  useRechargeBrowserCatalog: () => ({ selectionError: ref('') }),
  readBrowserCatalog: (form: unknown, signal: AbortSignal, directMode = false) =>
    directMode ? mock.directCatalog(form, signal) : mock.connectorCatalog(form, signal)
}));

const address: V2RechargeAddress = {
  id: '22222222-2222-4222-8222-222222222222',
  line1: '1221 SW Fourth Avenue',
  country: 'US',
  city: 'Portland',
  state: 'OR',
  postalCode: '97204',
  status: 'unused',
  usedAt: null,
  createdAt: '',
  updatedAt: ''
};
const settings: V2RechargeBitBrowserSettings = {
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenConfigured: true,
  localApiTokenMask: '已保存 ···1234',
  connectorTokenConfigured: true,
  connectorTokenMask: '已保存 ···5678',
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  proxyType: 'http',
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: 'https://proxy.example/…（已加密）',
  updatedAt: null
};
const launch: V2RechargeBitBrowserLaunch = {
  id: '11111111-1111-4111-8111-111111111111',
  mode: 'payment',
  connectorUrl: settings.connectorUrl,
  connectorToken: 'c'.repeat(64),
  agentToken: 'a'.repeat(64),
  bitBrowser: {
    localApiUrl: settings.localApiUrl,
    localApiToken: 'b'.repeat(32),
    groupName: settings.groupName,
    tagName: settings.tagName,
    proxyType: 'http',
    dynamicProxyUrl: 'https://proxy.example/secret'
  },
  address: {
    id: address.id,
    line1: address.line1,
    country: 'US',
    city: 'Portland',
    state: 'OR',
    postalCode: '97204'
  },
  safety: {
    lockedCurrency: 'USD',
    authorizeSinglePayment: true,
    manualPaymentConfirmation: true
  }
};
const resolutionLaunch: V2RechargeBitBrowserResolutionLaunch = {
  id: '55555555-5555-4555-8555-555555555555',
  mode: 'resolve_unknown_payment',
  connectorUrl: settings.connectorUrl,
  connectorToken: 'c'.repeat(64),
  agentToken: 'a'.repeat(64),
  plan: 'pro-20x',
  accountKey: 'd'.repeat(64),
  checkoutIdentifier: 'oaics_historical',
  sourceJobId: '66666666-6666-4666-8666-666666666666',
  verificationJobId: '77777777-7777-4777-8777-777777777777'
};

const jobs = ref<{ configured: boolean; items: V2RechargeJob[]; subscriptionCycleProtocol?: 1 }>({
  configured: true,
  items: []
});
const addresses = ref({
  items: [address],
  total: 1,
  page: 1,
  pageSize: 2000,
  totals: { unused: 1, used: 0, disabled: 0 }
});

const storedSettings = ref<V2RechargeBitBrowserSettings | undefined>(settings);
const phase = ref('ready');
const savedTotp = ref({
  items: [{ id: '88888888-8888-4888-8888-888888888888', name: 'ChatGPT', issuer: 'OpenAI' }]
});
const bankAccounts = ref<{ items: BankChatgptAccount[] }>({ items: [] });
const bankCurrencies = ref({
  items: [
    { code: 'USD', name: '美元', minorUnits: 2, active: true },
    { code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true }
  ]
});
let scope = effectScope();
let flow: ReturnType<typeof useAutoRecharge>;

const queryResult = (data: unknown) => ({
  data,
  phase,
  error: ref(null),
  isParameterTransition: ref(false),
  refresh: vi.fn().mockResolvedValue(undefined)
});
const sessionJson = (email = 'registered@example.com') => JSON.stringify({ user: { email } });
const directSessionJson = (email = 'registered@example.com') =>
  JSON.stringify({
    user: { email, id: 'user-1' },
    account: { id: 'account-1' },
    sessionToken: 'fixture-session'
  });

function pendingJsonFile() {
  let resolve: (value: string) => void = () => {};
  const text = vi.fn(
    () =>
      new Promise<string>((complete) => {
        resolve = complete;
      })
  );
  const target = { files: [{ size: 128, text }], value: 'synthetic.json' };
  return {
    event: { target } as unknown as Event,
    target,
    text,
    complete: (value: string) => resolve(value)
  };
}

function fillForm() {
  flow.updateJsonInput(sessionJson());
  flow.windowName.value = '申请gpt-001';
  flow.selectedAddressId.value = address.id;
  Object.assign(flow.details.value, {
    number: '5555555555554444',
    name: 'Test User',
    expiry: '12/30',
    cvc: '123'
  });
  flow.authorizeSinglePayment.value = true;
}

beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  mock.paymentControls.clear();
  mock.startDirectPayment.mockReset().mockResolvedValue(undefined);
  mock.paymentOwns.mockReturnValue(false);
  mock.paymentCancel.mockReset().mockResolvedValue(undefined);
  mock.queryIndex = 0;
  bankAccounts.value = { items: [] };
  mock.accountIdentity.mockResolvedValue({ email: 'registered@example.com' });
  mock.loginCredential.mockResolvedValue({
    email: 'registered@example.com',
    password: 'synthetic-password'
  });
  mock.automaticLoginCode.mockImplementation(async () => ({
    token: '123456',
    expiresAt: new Date(Date.now() + 30_000).toISOString()
  }));
  mock.accountTotpCode.mockImplementation(async () => ({
    token: '123456',
    expiresAt: new Date(Date.now() + 30_000).toISOString()
  }));
  jobs.value = { configured: true, items: [] };
  addresses.value.items = [address];
  savedTotp.value.items = [
    { id: '88888888-8888-4888-8888-888888888888', name: 'ChatGPT', issuer: 'OpenAI' }
  ];
  storedSettings.value = settings;
  phase.value = 'ready';
  mock.jobsQuery = queryResult(jobs);
  mock.addressesQuery = queryResult(addresses);
  mock.generateAddresses
    .mockReset()
    .mockResolvedValue({ count: 1, items: [{ ...address, id: 'generated' }] });
  mock.settingsQuery = queryResult(storedSettings);
  mock.serverProxySettingsQuery = queryResult(
    ref({ proxyId: null, proxy: null, legacyConfigured: false })
  );
  mock.defaultProxyCatalogQuery = queryResult(ref({ items: [] }));
  mock.totpQuery = queryResult(savedTotp);
  mock.bankAccountsQuery = queryResult(bankAccounts);
  mock.bankCurrenciesQuery = queryResult(bankCurrencies);
  mock.paymentCardsQuery = queryResult(ref({ items: [] }));
  mock.proxyCountriesQuery = queryResult(ref({ items: ['PH'] }));
  mock.proxiesQuery = {
    ...queryResult(
      ref({
        items: [
          {
            id: 'proxy-ph',
            countryCode: 'PH',
            kind: 'mobile',
            status: 'active',
            connectionMode: 'extraction',
            protocol: 'http',
            linkMask: '合成代理',
            remark1: null,
            remark2: null,
            createdAt: '',
            updatedAt: ''
          } satisfies RechargeProxyItem
        ],
        total: 1
      })
    ),
    ensureFresh: vi.fn().mockResolvedValue(undefined)
  };
  mock.preparePaymentCard.mockResolvedValue({ cardId: '55555555-5555-4555-8555-555555555555' });
  mock.matchCardName.mockResolvedValue({
    name: 'Test User',
    confirmed: false,
    cardId: null,
    billingAddressId: null
  });
  mock.checkCardAvailability.mockResolvedValue({ available: true });
  mock.managedCardDetail.mockReset().mockResolvedValue({
    allowedPlans: ['plus'],
    id: 'card-a',
    status: 'active',
    currencyCode: 'PHP',
    number: '5555555555554444',
    expiry: '12/30',
    billingName: 'Test User',
    billingAddressId: address.id
  });
  mock.listTotpAccounts.mockImplementation(async () => ({
    items: [
      {
        id: savedTotp.value.items[0]!.id,
        name: 'ChatGPT',
        issuer: 'OpenAI',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        token: '123456',
        expiresAt: new Date(Date.now() + 20_000).toISOString(),
        createdAt: '',
        updatedAt: ''
      }
    ]
  }));
  mock.startBitBrowser.mockImplementation(async (input) => ({ ...launch, id: input.id }));
  mock.startServer.mockImplementation(async (input) => ({ id: input.id }));
  mock.recheckServer.mockImplementation(async (input) => ({ id: input.id }));
  mock.cancelServer.mockImplementation(async (id) => ({ id }));
  mock.startBitBrowserOpen.mockImplementation(
    async (input: { id: string; windowName: string }) => ({
      id: input.id,
      mode: 'open_browser' as const,
      connectorUrl: settings.connectorUrl,
      connectorToken: launch.connectorToken,
      agentToken: launch.agentToken,
      bitBrowser: launch.bitBrowser
    })
  );
  mock.recheckBitBrowser.mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
    mode: 'recheck',
    transport: 'web_direct',
    connectorUrl: '',
    connectorToken: '',
    agentToken: launch.agentToken,
    bitBrowser: launch.bitBrowser
  });
  mock.resolveNoBankRequest.mockResolvedValue({ id: resolutionLaunch.id, alreadyResolved: true });
  mock.confirmResolution.mockResolvedValue('confirm');
  mock.connectorStart.mockResolvedValue({ ok: true, accepted: true });
  mock.connectorStatus.mockResolvedValue({ ok: true, done: false, waitingForUser: false });
  mock.connectorResume.mockResolvedValue({ ok: true });
  mock.connectorSubmitCode.mockResolvedValue({ ok: true });
  mock.connectorCancel.mockResolvedValue({ ok: true });
  mock.connectorHealth.mockResolvedValue({ ok: true });
  mock.connectorCatalog.mockResolvedValue({
    connectorCapabilities: ['account-auto-login-v1'],
    groups: [{ id: 'g', name: settings.groupName }],
    tags: [{ id: 't', name: settings.tagName }]
  });
  mock.directCatalog.mockResolvedValue({
    groups: [{ id: 'group-direct', name: settings.groupName }],
    tags: [{ id: 'tag-direct', name: settings.tagName }]
  });
  mock.directStart.mockImplementation(async () => {
    mock.directHandles.mockReturnValue(true);
  });
  mock.directRunning = ref(false);
  mock.directOwns.mockReturnValue(false);
  mock.directHandles.mockReturnValue(false);
  mock.directBrowserCallback.mockResolvedValue({ ok: true });
  mock.directCancel.mockReset().mockResolvedValue(undefined);

  mock.cancelBitBrowser.mockResolvedValue({ id: launch.id });
  mock.abandonUnreceivedBitBrowser.mockResolvedValue({ id: launch.id });
  mock.bitBrowserAccess.mockResolvedValue({
    connectorUrl: settings.connectorUrl,
    connectorToken: launch.connectorToken
  });
  mock.updateBitBrowserSettings.mockResolvedValue(settings);
  scope = effectScope();
  flow = scope.run(() => useAutoRecharge({ clearPaymentValidation: mock.clearPaymentValidation }))!;
  flow.operationMode.value = 'payment';
});

afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});

const account = (hasPassword = true, hasTotp = false): BankChatgptAccount =>
  ({
    id: 'account-fixture',
    emailMasked: 're***@example.com',
    status: 'active',
    subscriptionState: 'active',
    currentPlan: 'go',
    hasPassword,
    hasTotp
  }) as BankChatgptAccount;
const job = (
  state: V2RechargeJob['state'],
  result: V2RechargeJob['result'] = {}
): V2RechargeJob => ({
  id: 'job-fixture',
  chatgptAccountId: 'account-fixture',
  plan: 'go',
  action: 'bitbrowser',
  state,
  result: { mode: 'payment', ...result },
  createdAt: '',
  updatedAt: ''
});

it('历史付款恢复冲突不引导普通重试，保留资料并指向原单只读核实', async () => {
  jobs.value = {
    configured: true,
    items: [
      job('finished', {
        status: 'blocked',
        reason: 'durable_state_unavailable',
        payment_attempted: false,
        payment_requests_sent: 0,
        callback_operation: 'restore',
        callback_failure_kind: 'http',
        callback_http_status: 409,
        callback_business_reason: 'callback_previous_payment_unverified'
      })
    ]
  };
  flow.selectJob('job-fixture');
  await nextTick();
  expect(flow.workflowMessage.value).toContain('历史付款或订阅结果待核实');
  expect(flow.workflowMessage.value).toContain('只读复查原订单');
  expect(flow.workflowMessage.value).not.toContain('可再次执行');
  expect(mock.startBitBrowser).not.toHaveBeenCalled();
  expect(mock.resolveNoBankRequest).not.toHaveBeenCalled();
});

async function choosePasswordAccount(hasPassword = true, hasTotp = false) {
  bankAccounts.value.items = [account(hasPassword, hasTotp)];
  flow.loginMethod.value = 'password';
  flow.selectedBankAccountId.value = 'account-fixture';
  await nextTick();
  await nextTick();
}

describe('比特浏览器充值入口', () => {
  it('默认菲律宾移动代理自动进入最终任务，缺少同国代理时不能启动', async () => {
    fillForm();
    await nextTick();
    expect(flow.defaultCountryCode.value).toBe('PH');
    expect(flow.selectedProxyCountryCode.value).toBe('PH');
    expect(flow.selectedProxyId.value).toBe('proxy-ph');
    await flow.start();
    expect(mock.startBitBrowser.mock.calls[0]?.[0]).toMatchObject({
      proxyCountryCode: 'PH',
      proxyId: 'proxy-ph',
      lockedCurrency: 'PHP'
    });
  });
  it('所选国家的代理库为空时阻止执行，不沿用设置中的其他代理', async () => {
    fillForm();
    (mock.proxiesQuery.data as Ref<{ items: RechargeProxyItem[]; total: number }>).value = {
      items: [],
      total: 0
    };
    await nextTick();
    expect(flow.selectedProxyId.value).toBe('');
    expect(flow.canStart.value).toBe(false);
    expect(flow.workflowMessage.value).toContain('所选国家暂无启用代理');
    await flow.start();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });
  it('登录与充值共用比特直连，切换模式保留检测且不访问充值助手', async () => {
    flow.operationMode.value = 'open_browser';
    await flow.testConnector();
    expect(flow.connectorStatus.value).toBe('online');
    flow.operationMode.value = 'payment';
    expect(flow.connectorStatus.value).toBe('online');
    let complete!: (value: unknown) => void;
    mock.directCatalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const check = flow.testConnector();
    expect(flow.connectorStatus.value).toBe('checking');
    flow.operationMode.value = 'open_browser';
    complete({ groups: [{ name: settings.groupName }], tags: [{ name: settings.tagName }] });
    await check;
    expect(flow.connectorStatus.value).toBe('online');
    expect(flow.connectorMessage.value).toContain('直连');
    expect(mock.connectorCatalog).not.toHaveBeenCalled();
  });
  it('新充值默认按未使用地址分配，不继续选已使用或停用地址', () => {
    expect(flow.operationMode.value).toBe('payment');
    flow.updateJsonInput(sessionJson());
    expect(flow.details.value.email).toBe('registered@example.com');
    expect(flow.windowName.value).toBe('ChatGPT-registered');
    expect(flow.selectedAddressId.value).toBe(address.id);
    addresses.value.items = [{ ...address, status: 'used' }];
    expect(flow.selectedAddress.value).toBeUndefined();
    expect(flow.availableAddresses.value).toEqual([]);
    addresses.value.items = [{ ...address, status: 'disabled' }];
    expect(flow.availableAddresses.value).toEqual([]);
  });

  it('已用地址刷新后，新充值自动选择创建最早的未使用地址，不受列表返回顺序影响', () => {
    const first = { ...address, createdAt: '2026-10-01T00:00:00Z' };
    const second = { ...address, id: 'next-address', createdAt: '2026-10-02T00:00:00Z' };
    const third = { ...address, id: 'last-address', createdAt: '2026-10-03T00:00:00Z' };
    addresses.value.items = [third, second, first];
    expect(flow.selectedAddressId.value).toBe(first.id);
    addresses.value.items = [
      third,
      second,
      { ...first, status: 'used', usedAt: '2026-10-04T00:00:00Z' }
    ];
    expect(flow.availableAddresses.value.map((item) => item.id)).toEqual([second.id, third.id]);
    expect(flow.selectedAddressId.value).toBe(second.id);
  });

  it('同一卡新充值仍选下一条未使用地址，不被历史姓名匹配或选卡响应改回已用地址', async () => {
    const next = { ...address, id: 'next-address', createdAt: '2026-10-02T00:00:00Z' };
    addresses.value.items = [{ ...address, status: 'used', usedAt: '2026-10-01T00:00:00Z' }, next];
    mock.managedCardDetail.mockResolvedValueOnce({
      allowedPlans: ['plus'],
      id: 'card-a',
      status: 'active',
      number: '5555555555554444',
      expiry: '12/30',
      billingName: 'Historic Person',
      billingAddressId: address.id
    });
    mock.matchCardName.mockResolvedValueOnce({
      name: 'Historic Person',
      confirmed: true,
      cardId: 'bound-card',
      billingAddressId: address.id
    });
    await flow.selectSavedCard('card-a');
    await flow.nameMatch.ensureReady();
    expect(flow.details.value.name).toBe('Historic Person');
    expect(flow.selectedAddressId.value).toBe(next.id);
    expect(flow.availableAddresses.value.map((item) => item.id)).toEqual([next.id]);
  });

  it('执行中的地址被标记已用时保留原表单，任务结束后才转到下一条未使用地址', () => {
    const next = { ...address, id: 'next-address', createdAt: '2026-10-02T00:00:00Z' };
    addresses.value.items = [address, next];
    jobs.value.items = [job('running', { payment_attempted: true, payment_requests_sent: 1 })];
    addresses.value.items = [{ ...address, status: 'used', usedAt: '2026-10-01T00:00:00Z' }, next];
    expect(flow.selectedAddressId.value).toBe(address.id);
    jobs.value.items = [job('finished', { payment_attempted: true, payment_requests_sent: 1 })];
    expect(flow.selectedAddressId.value).toBe(next.id);
  });
  it('明确付款前取消显示已停止，不再提示充值失败；未知付款继续保留核对提示', async () => {
    jobs.value.items = [
      job('finished', {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      })
    ];
    flow.selectJob('job-fixture');
    await nextTick();
    expect(flow.workflowMessage.value).toBe('本次任务已停止，未提交付款；填写资料已保留。');
    jobs.value.items = [
      job('finished', {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_status: 'unknown'
      })
    ];
    expect(flow.workflowMessage.value).not.toContain('未提交付款');
    expect(flow.workflowMessage.value).toContain('只读复查原订单');
  });
  it('无唯一账号邮箱或非法 JSON 不能启动，错误不回显授权内容', () => {
    fillForm();
    flow.updateJsonInput('{"token":"sensitive-fixture"}');
    expect(flow.canStart.value).toBe(false);
    expect(flow.jsonError.value).not.toContain('sensitive-fixture');
    flow.updateJsonInput('not-json');
    expect(flow.sessionJson.value).toBe('');
  });
  it('选择未绑定姓名的已保存银行卡后自动从姓名库回填，无需手填或点击执行', async () => {
    mock.managedCardDetail.mockResolvedValueOnce({
      allowedPlans: ['plus'],
      id: 'card-a',
      status: 'active',
      currencyCode: 'PHP',
      number: '5555555555554444',
      expiry: '12/30',
      billingName: null,
      billingAddressId: address.id
    });
    mock.matchCardName.mockResolvedValueOnce({
      name: 'Library Person',
      confirmed: false,
      cardId: 'legacy-card-a',
      billingAddressId: address.id
    });
    await flow.selectSavedCard('card-a');
    await nextTick();
    expect(mock.matchCardName).toHaveBeenCalledExactlyOnceWith('5555555555554444');
    expect(flow.details.value.name).toBe('Library Person');
    expect(flow.selectedPaymentCardId.value).toBe('card-a');
    flow.details.value.number = '4111111111111111';
    expect(flow.selectedPaymentCardId.value).toBe('');
    expect(mock.preparePaymentCard).not.toHaveBeenCalled();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.startDirectPayment).not.toHaveBeenCalled();
  });
  it.each(['empty', 'all_used'])(
    '无未使用地址时自动生成并填写明细，不改变代理和币种：%s',
    async (state) => {
      addresses.value.items =
        state === 'empty' ? [] : [{ ...address, status: 'used', usedAt: '2026-10-01T00:00:00Z' }];
      const generated = {
        ...address,
        id: 'generated',
        line1: '100 Main St',
        city: 'Nashua',
        state: 'New Hampshire',
        postalCode: '03060'
      };
      mock.generateAddresses.mockResolvedValueOnce({ count: 1, items: [generated] });
      (mock.addressesQuery.refresh as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        addresses.value.items = [generated];
      });
      fillForm();
      await flow.nameMatch.ensureReady();
      await vi.waitFor(() => expect(flow.selectedAddressId.value).toBe('generated'));
      expect(mock.generateAddresses).toHaveBeenCalledExactlyOnceWith(1);
      expect(flow.selectedAddressId.value).toBe('generated');
      expect(flow.details.value).toMatchObject({
        country: 'US',
        line1: '100 Main St',
        city: 'Nashua',
        state: 'New Hampshire',
        postal_code: '03060'
      });
      expect(flow.selectedProxyCountryCode.value).toBe('PH');
      expect(flow.lockedCurrency.value).toBe('PHP');
      expect(mock.startBitBrowser).not.toHaveBeenCalled();
    }
  );
  it('仅登录模式不生成地址；切回充值后旧卡的历史地址不阻止生成未使用地址', async () => {
    flow.operationMode.value = 'open_browser';
    addresses.value.items = [];
    fillForm();
    await nextTick();
    await nextTick();
    expect(mock.generateAddresses).not.toHaveBeenCalled();
    expect(mock.matchCardName).not.toHaveBeenCalled();
    mock.matchCardName.mockResolvedValueOnce({
      name: 'Historic Person',
      confirmed: true,
      cardId: 'bound-card',
      billingAddressId: 'missing-bound-address'
    });
    flow.operationMode.value = 'payment';
    await flow.nameMatch.ensureReady();
    await nextTick();
    await nextTick();
    expect(flow.canGenerateAddress.value).toBe(true);
    await vi.waitFor(() => expect(mock.generateAddresses).toHaveBeenCalledOnce());
    expect(flow.selectedAddress.value).toBeUndefined();
  });
  it('手工选择地址后，迟到的生成结果不能覆盖选择', async () => {
    mock.matchCardName.mockResolvedValueOnce({
      name: 'James Smith',
      confirmed: false,
      cardId: null,
      billingAddressId: null
    });
    fillForm();
    await flow.nameMatch.ensureReady();
    let finish!: (value: unknown) => void;
    mock.generateAddresses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const request = flow.generateBillingAddress();
    flow.markAddressSelectionManual();
    finish({ count: 1, items: [{ ...address, id: 'generated' }] });
    await request;
    expect(flow.selectedAddressId.value).toBe(address.id);
  });
  it('旧卡历史地址缺失不妨碍新充值选择最早未使用地址，原姓名继续保留', async () => {
    mock.matchCardName.mockResolvedValueOnce({
      name: 'Historic Person',
      confirmed: true,
      cardId: 'bound-card',
      billingAddressId: 'missing-bound-address'
    });
    fillForm();
    await flow.nameMatch.ensureReady();
    await nextTick();
    expect(flow.selectedAddress.value?.id).toBe(address.id);
    expect(flow.details.value.line1).toBe(address.line1);
    expect(flow.details.value.name).toBe('Historic Person');
    expect(flow.canGenerateAddress.value).toBe(true);
    expect(flow.canStart.value).toBe(true);
    expect(mock.generateAddresses).not.toHaveBeenCalled();
  });
  it('姓名匹配等待和失败时显示自动填写状态，不要求手填姓名', async () => {
    let reject!: (cause: Error) => void;
    mock.matchCardName.mockImplementationOnce(
      () => new Promise((_resolve, fail) => (reject = fail))
    );
    fillForm();
    flow.details.value.name = '';
    expect(flow.workflowMessage.value).toBe('正在填写银行卡账单姓名，请稍候。');
    expect(flow.canStart.value).toBe(false);
    const ready = flow.nameMatch.ensureReady();
    reject(new Error('姓名库暂无启用姓名，请先录入姓名'));
    await expect(ready).rejects.toThrow('姓名库暂无启用姓名');
    expect(flow.workflowMessage.value).toBe('账单姓名匹配失败，请在账单姓名处重试。');
    expect(flow.canStart.value).toBe(false);
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });
  it('切换支付币种保留已选卡、有效期和账单地址，只清理临时安全码', async () => {
    await flow.selectSavedCard('card-a');
    await nextTick();
    flow.details.value.cvc = '123';
    const number = flow.details.value.number;
    const expiry = flow.details.value.expiry;
    const selectedAddress = flow.selectedAddressId.value;
    flow.lockedCurrency.value = 'USD';
    await nextTick();
    expect(flow.selectedPaymentCardId.value).toBe('card-a');
    expect(flow.details.value.number).toBe(number);
    expect(flow.details.value.expiry).toBe(expiry);
    expect(flow.selectedAddressId.value).toBe(selectedAddress);
    expect(flow.details.value.cvc).toBe('');
  });
  it('手选只限 Pro 的卡不能用于 Plus，切换套餐清除旧卡和安全码', async () => {
    mock.managedCardDetail.mockResolvedValueOnce({
      id: 'card-a',
      status: 'active',
      number: '5555555555554444',
      expiry: '12/30',
      allowedPlans: ['pro_20x']
    });
    await flow.selectSavedCard('card-a');
    expect(flow.error.value).toContain('不适用当前套餐');
    expect(flow.selectedPaymentCardId.value).toBe('');
    expect(mock.matchCardName).not.toHaveBeenCalled();
    fillForm();
    flow.plan.value = 'pro-20x';
    await nextTick();
    expect(flow.details.value.number).toBe('');
    expect(flow.details.value.cvc).toBe('');
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });
  it('银行卡和地址通过校验后显示就绪，不再要求重复补齐', async () => {
    fillForm();
    await nextTick();
    expect(flow.canStart.value).toBe(true);
    expect(flow.workflowMessage.value).toContain('资料已就绪');
    expect(flow.workflowMessage.value).not.toContain('补齐');
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });
  it('已选地址时只指出无效卡号和缺少姓名，不回显敏感资料', async () => {
    fillForm();
    await nextTick();
    flow.details.value.number = '5555555555554445';
    flow.details.value.name = '';
    expect(flow.canStart.value).toBe(false);
    expect(flow.workflowMessage.value).toContain('银行卡号校验未通过');
    expect(flow.workflowMessage.value).toContain('账单姓名将自动填入');
    expect(flow.workflowMessage.value).not.toContain('账单地址');
    expect(flow.workflowMessage.value).not.toContain(flow.details.value.number);
    expect(flow.workflowMessage.value).not.toContain(flow.details.value.cvc);
    expect(flow.workflowMessage.value).not.toContain(flow.details.value.email);
  });
  it('选中地址也检查地址内的必填资料，并指出具体字段', async () => {
    fillForm();
    await nextTick();
    addresses.value.items = [{ ...address, postalCode: '' }];
    expect(flow.selectedAddress.value?.id).toBe(address.id);
    expect(flow.canStart.value).toBe(false);
    expect(flow.workflowMessage.value).toContain('账单地址：请填写邮编');
  });
  it('银行卡和地址校验通过但未授权时准确提示勾选，不改变启动条件', async () => {
    fillForm();
    await nextTick();
    flow.authorizeSinglePayment.value = false;
    expect(flow.canStart.value).toBe(false);
    expect(flow.workflowMessage.value).toContain('请勾选本次单次付款授权');
    expect(flow.workflowMessage.value).not.toContain('补齐');
  });
  it('仅登录模式无需银行卡或账单地址，继续显示原登录提示', () => {
    flow.updateJsonInput(directSessionJson());
    flow.operationMode.value = 'open_browser';
    flow.details.value.number = '';
    flow.details.value.name = '';
    expect(flow.canStartOpen.value).toBe(true);
    expect(flow.workflowMessage.value).toBe('核对窗口名称后，点击即可打开比特浏览器并自动登录。');
  });
  it('格式不完整和真正超出大小分别提示，不把平板复制的短 JSON 当成超限', () => {
    flow.updateJsonInput('{"user":{"email":"registered@example.com"');
    expect(flow.jsonError.value).toContain('格式不完整');
    expect(flow.jsonError.value).not.toContain('65 KB');
    flow.updateJsonInput(
      JSON.stringify({
        ...JSON.parse(directSessionJson()),
        device: 'tablet',
        extra: 'x'.repeat(7000)
      })
    );
    expect(flow.jsonError.value).toBe('');
    expect(flow.details.value.email).toBe('registered@example.com');
    flow.updateJsonInput('x'.repeat(65_001));
    expect(flow.jsonError.value).toContain('超过 65 KB');
    expect(flow.sessionJson.value).toBe('');
  });
  it('直接粘贴第二个 JSON 替换第一个账号，提交只使用新授权，无需刷新', async () => {
    fillForm();
    const replacement = directSessionJson('replacement@example.com');
    flow.updateJsonInput(replacement);
    expect(flow.jsonInput.value).toBe('');
    expect(flow.details.value.email).toBe('replacement@example.com');
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startBitBrowser.mock.calls[0]![0].expectedEmail).toBe('replacement@example.com');
    expect(mock.startDirectPayment.mock.calls[0]![0].credential.sessionJson).toBe(replacement);
  });
  it('同账号新授权也替换旧授权，仅登录直连拿到最新会话', async () => {
    const original = JSON.parse(directSessionJson()) as Record<string, unknown>;
    const replacement = JSON.stringify({ ...original, sessionToken: 'synthetic-new-session' });
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(JSON.stringify(original));
    flow.updateJsonInput(replacement);
    expect(flow.canStartOpen.value).toBe(true);
    await flow.startOpen();
    expect(mock.directStart.mock.calls[0]![1]).toEqual({ sessionJson: replacement });
  });
  it('替换 JSON 保留手工窗口名，文件替换也更新自动窗口名', async () => {
    flow.updateJsonInput(directSessionJson('first@example.com'));
    flow.updateJsonInput(directSessionJson('replacement@example.com'));
    expect(flow.windowName.value).toBe('ChatGPT-replacement');
    const file = pendingJsonFile();
    const importing = flow.importJson(file.event);
    file.complete(directSessionJson('second@example.com'));
    await importing;
    expect(flow.windowName.value).toBe('ChatGPT-second');
    flow.windowName.value = '客户手工窗口名';
    flow.updateJsonInput(directSessionJson('third@example.com'));
    expect(flow.windowName.value).toBe('客户手工窗口名');
  });
  it.each(['not-json', '{"user":{"email":"first@example.com"', '{"token":"synthetic-only"}'])(
    '无效替换不能继续提交旧账号授权，并提示错误（%s）',
    async (invalid) => {
      fillForm();
      flow.updateJsonInput(invalid);
      expect(flow.sessionJson.value).toBe('');
      expect(flow.details.value.email).toBe('');
      expect(flow.jsonError.value).not.toBe('');
      expect(flow.jsonError.value).not.toContain(invalid);
      expect(flow.canStart.value).toBe(false);
      expect(flow.canStartOpen.value).toBe(false);
      await flow.start();
      await flow.startOpen();
      expect(mock.startBitBrowser).not.toHaveBeenCalled();
      expect(mock.startBitBrowserOpen).not.toHaveBeenCalled();
    }
  );
  it('文件读取期间粘贴的新 JSON 不被迟到文件覆盖', async () => {
    fillForm();
    const file = pendingJsonFile();
    const importing = flow.importJson(file.event);
    expect(flow.importing.value).toBe(true);
    expect(flow.canStart.value).toBe(false);
    const replacement = directSessionJson('replacement@example.com');
    flow.updateJsonInput(replacement);
    file.complete(directSessionJson('file@example.com'));
    await importing;
    expect(flow.importing.value).toBe(false);
    expect(flow.sessionJson.value).toBe(replacement);
    expect(flow.details.value.email).toBe('replacement@example.com');
    expect(flow.canStart.value).toBe(true);
  });
  it('连续导入文件只应用最后一次选择，先前文件迟到无效', async () => {
    const first = pendingJsonFile();
    const second = pendingJsonFile();
    const firstImport = flow.importJson(first.event);
    const secondImport = flow.importJson(second.event);
    const replacement = directSessionJson('replacement@example.com');
    second.complete(replacement);
    await secondImport;
    first.complete(directSessionJson('first@example.com'));
    await firstImport;
    expect(flow.sessionJson.value).toBe(replacement);
    expect(flow.details.value.email).toBe('replacement@example.com');
    expect(flow.importing.value).toBe(false);
  });
  it('文件读取期间粘贴无效新 JSON 后，旧文件不能恢复旧授权', async () => {
    fillForm();
    const file = pendingJsonFile();
    const importing = flow.importJson(file.event);
    flow.updateJsonInput('synthetic-invalid-json');
    file.complete(directSessionJson());
    await importing;
    expect(flow.sessionJson.value).toBe('');
    expect(flow.details.value.email).toBe('');
    expect(flow.canStart.value).toBe(false);
    expect(flow.jsonError.value).not.toBe('');
  });
  it('文件读取期间改为账号密码，迟到 JSON 不能覆盖该账号邮箱', async () => {
    const file = pendingJsonFile();
    const importing = flow.importJson(file.event);
    await choosePasswordAccount();
    file.complete(directSessionJson('file@example.com'));
    await importing;
    expect(flow.importing.value).toBe(false);
    expect(flow.details.value.email).toBe('registered@example.com');
    expect(flow.sessionJson.value).toBe('');
    expect(flow.jsonInput.value).toBe('');
  });
  it('原任务运行时可替换下一次授权，但不能同时启动第二次任务', async () => {
    fillForm();
    const file = pendingJsonFile();
    const importing = flow.importJson(file.event);
    jobs.value.items = [job('running')];
    expect(flow.formLocked.value).toBe(false);
    expect(flow.canStart.value).toBe(false);
    expect(flow.canStartOpen.value).toBe(false);
    file.complete(directSessionJson('file@example.com'));
    await importing;
    expect(flow.sessionJson.value).toContain('file@example.com');
    flow.updateJsonInput(directSessionJson('replacement@example.com'));
    expect(flow.sessionJson.value).toContain('replacement@example.com');
    await flow.start();
    await flow.startOpen();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.startBitBrowserOpen).not.toHaveBeenCalled();
  });
  it('单次付款授权和安全码必须本次填写，不需要填写最高付款金额', () => {
    fillForm();
    expect(flow.canStart.value).toBe(true);
    expect(flow).not.toHaveProperty('maxAmount');
    flow.authorizeSinglePayment.value = false;
    expect(flow.canStart.value).toBe(false);
    flow.authorizeSinglePayment.value = true;
    flow.details.value.cvc = '';
    expect(flow.canStart.value).toBe(false);
    flow.details.value.cvc = '123';
    expect(flow.canStart.value).toBe(true);
  });
  it('网页直连充值；服务器任务只收到资料引用，付款秘密只交当前网页控制器', async () => {
    fillForm();
    await flow.start();
    expect(mock.startBitBrowser).toHaveBeenCalledOnce();
    const input = mock.startBitBrowser.mock.calls[0]![0];
    expect(input).toMatchObject({
      directMode: true,
      manualPaymentConfirmation: true,
      authorizeSinglePayment: true
    });
    expect(input).not.toHaveProperty('sessionJson');
    expect(input).not.toHaveProperty('details');
    expect(input).not.toHaveProperty('maxAmount');
    expect(input).not.toHaveProperty('maxAmountMinor');
    expect(JSON.stringify(input)).not.toContain('5555555555554444');
    expect(mock.startDirectPayment.mock.calls[0]![0]).toMatchObject({
      credential: { sessionJson: sessionJson() },
      payment: { cvc: '123' },
      launch: { safety: { manualPaymentConfirmation: true } }
    });
    expect(mock.startDirectPayment.mock.calls[0]![0].launch.safety).toEqual({
      lockedCurrency: 'PHP',
      authorizeSinglePayment: true,
      manualPaymentConfirmation: true
    });
    expect(mock.startServer).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.connectorHealth).not.toHaveBeenCalled();
  });
  it('旧启动回执的金额限制字段不再传给本机，币种和人工确认保护保留', async () => {
    mock.startBitBrowser.mockResolvedValue({
      ...launch,
      safety: { ...launch.safety, maxAmount: '0.01', maxAmountMinor: 1 }
    });
    fillForm();
    await flow.start();
    expect(mock.startDirectPayment.mock.calls[0]![0].launch.safety).toEqual({
      lockedCurrency: 'PHP',
      authorizeSinglePayment: true,
      manualPaymentConfirmation: true
    });
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    '网页内置周期协议按API=%s与launch回传协商，旧助手能力=%s不影响最终付款确认',
    async (apiReady, legacyHelperReady) => {
      fillForm();
      if (apiReady) jobs.value.subscriptionCycleProtocol = 1;
      mock.directCatalog.mockResolvedValueOnce({
        groups: [{ id: 'g', name: settings.groupName }],
        tags: [{ id: 't', name: settings.tagName }],
        connectorCapabilities: legacyHelperReady ? ['next-subscription-cycle-v1'] : []
      });
      mock.startBitBrowser.mockImplementationOnce(async (input) => ({
        ...structuredClone(launch),
        id: input.id,
        ...(input.subscriptionCycleProtocol === 1 ? { subscriptionCycleProtocol: 1 } : {})
      }));
      await flow.start();
      const apiInput = mock.startBitBrowser.mock.calls[0]?.[0];
      const helperInput = mock.startDirectPayment.mock.calls[0]?.[0].launch;
      expect(apiInput?.subscriptionCycleProtocol).toBe(apiReady ? 1 : undefined);
      expect(helperInput?.subscriptionCycleProtocol).toBe(apiReady ? 1 : undefined);
      expect(apiInput).toMatchObject({
        manualPaymentConfirmation: true,
        authorizeSinglePayment: true
      });
      expect(helperInput?.safety).toMatchObject({
        manualPaymentConfirmation: true,
        authorizeSinglePayment: true
      });
    }
  );
  it('启动API未回传周期协议时不向网页控制器冒充三方协议已匹配', async () => {
    fillForm();
    jobs.value.subscriptionCycleProtocol = 1;
    mock.directCatalog.mockResolvedValueOnce({
      groups: [{ id: 'g', name: settings.groupName }],
      tags: [{ id: 't', name: settings.tagName }],
      connectorCapabilities: ['next-subscription-cycle-v1']
    });
    await flow.start();
    expect(mock.startBitBrowser.mock.calls[0]?.[0].subscriptionCycleProtocol).toBe(1);
    expect(
      mock.startDirectPayment.mock.calls[0]?.[0].launch.subscriptionCycleProtocol
    ).toBeUndefined();
  });
  it('待返回姓名核实完成后，卡准备、任务账单姓名和本机详情均使用已验证姓名', async () => {
    let release!: (value: unknown) => void;
    mock.matchCardName.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    fillForm();
    const starting = flow.start();
    await vi.waitFor(() => expect(mock.matchCardName).toHaveBeenCalledOnce());
    expect(mock.preparePaymentCard).not.toHaveBeenCalled();
    release({
      name: 'Verified Synthetic Owner',
      confirmed: true,
      cardId: '55555555-5555-4555-8555-555555555555',
      billingAddressId: null
    });
    await starting;
    expect(flow.details.value.name).toBe('Verified Synthetic Owner');
    expect(mock.preparePaymentCard.mock.calls[0]?.[0].name).toBe('Verified Synthetic Owner');
    expect(mock.startBitBrowser.mock.calls[0]?.[0].billingName).toBe('Verified Synthetic Owner');
    expect(mock.startDirectPayment.mock.calls[0]?.[0].payment.name).toBe(
      'Verified Synthetic Owner'
    );
  });
  it('姓名匹配只回填原卡姓名，新任务与网页控制器均使用当前未使用地址', async () => {
    const linked = {
      ...address,
      id: '88888888-8888-4888-8888-888888888888',
      line1: 'Historic Billing Avenue',
      status: 'used' as const
    };
    addresses.value.items = [address, linked];
    let release!: (value: unknown) => void;
    mock.matchCardName.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    mock.startBitBrowser.mockImplementationOnce(async (input) => ({
      ...structuredClone(launch),
      id: input.id,
      address: { ...launch.address, id: address.id, line1: address.line1 }
    }));
    fillForm();
    const originalPlan = flow.plan.value;
    const originalCurrency = flow.lockedCurrency.value;
    const originalEmail = flow.details.value.email;
    const starting = flow.start();
    await vi.waitFor(() => expect(mock.matchCardName).toHaveBeenCalledOnce());
    release({
      name: 'Verified Synthetic Owner',
      confirmed: true,
      cardId: '55555555-5555-4555-8555-555555555555',
      billingAddressId: linked.id
    });
    await starting;
    expect(flow.selectedAddressId.value).toBe(address.id);
    expect(flow.details.value.line1).toBe(address.line1);
    expect(mock.startBitBrowser.mock.calls[0]?.[0]).toMatchObject({
      addressId: address.id,
      billingName: 'Verified Synthetic Owner',
      plan: originalPlan,
      lockedCurrency: originalCurrency,
      expectedEmail: originalEmail
    });
    expect(mock.startDirectPayment.mock.calls[0]?.[0].launch.address).toMatchObject({
      id: address.id,
      line1: address.line1
    });
    expect(mock.startBitBrowser).toHaveBeenCalledOnce();
  });
  it.each(['name', 'card', 'card_reference', 'plan', 'currency', 'account'] as const)(
    '姓名核实等待中明确修改%s时停止旧点击，不混用旧绑定和新输入',
    async (change) => {
      let release!: (value: unknown) => void;
      mock.matchCardName.mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve))
      );
      fillForm();
      const starting = flow.start();
      await vi.waitFor(() => expect(mock.matchCardName).toHaveBeenCalledOnce());
      if (change === 'name') flow.details.value.name = 'Manually Changed Owner';
      else if (change === 'card') flow.details.value.number = '4111111111111111';
      else if (change === 'card_reference')
        flow.selectedPaymentCardId.value = 'operator-selected-card';
      else if (change === 'plan') flow.plan.value = 'pro-20x';
      else if (change === 'currency')
        flow.lockedCurrency.value = flow.lockedCurrency.value === 'PHP' ? 'USD' : 'PHP';
      else flow.loginMethod.value = 'password';
      release({
        name: 'Verified Synthetic Owner',
        confirmed: true,
        cardId: '55555555-5555-4555-8555-555555555555',
        billingAddressId: null
      });
      await starting;
      expect(mock.preparePaymentCard).not.toHaveBeenCalled();
      expect(mock.startBitBrowser).not.toHaveBeenCalled();
      expect(mock.connectorStart).not.toHaveBeenCalled();
      expect(mock.startDirectPayment).not.toHaveBeenCalled();
      expect(flow.busy.value).toBe(false);
      expect(flow.error.value).toContain('核实期间已变化');
    }
  );
  it('姓名匹配待返回时人工重选账单地址，不被旧自动回填覆盖且旧执行停留可重试', async () => {
    const manual = {
      ...address,
      id: '88888888-8888-4888-8888-888888888888',
      line1: 'Manual Billing Avenue'
    };
    addresses.value.items = [address, manual];
    let release!: (value: unknown) => void;
    mock.matchCardName.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    fillForm();
    const starting = flow.start();
    await vi.waitFor(() => expect(mock.matchCardName).toHaveBeenCalledOnce());
    flow.markAddressSelectionManual();
    flow.selectedAddressId.value = manual.id;
    release({
      name: 'Verified Synthetic Owner',
      confirmed: true,
      cardId: '55555555-5555-4555-8555-555555555555',
      billingAddressId: address.id
    });
    await starting;
    expect(flow.selectedAddressId.value).toBe(manual.id);
    expect(flow.details.value.line1).toBe(manual.line1);
    expect(mock.preparePaymentCard).not.toHaveBeenCalled();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('核实期间已变化');
    expect(flow.busy.value).toBe(false);
  });
  it('充值预检等待读取时身份切换，旧点击不继续创建任务且旧finally不释放新操作busy', async () => {
    fillForm();
    let release!: () => void;
    mock.checkCardAvailability.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const starting = flow.start();
    await vi.waitFor(() => expect(mock.checkCardAvailability).toHaveBeenCalledOnce());
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    flow.error.value = '新身份充值提示';
    flow.busy.value = true;
    const refresh = mock.jobsQuery.refresh as ReturnType<typeof vi.fn>;
    const reads = refresh.mock.calls.length;
    release();
    await starting;
    expect(mock.preparePaymentCard).not.toHaveBeenCalled();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.startDirectPayment).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('新身份充值提示');
    expect(flow.busy.value).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(reads);
  });
  it('连接配置在预检途中变化时不混用旧连接和新任务，并保留用户表单', async () => {
    fillForm();
    let release!: () => void;
    mock.checkCardAvailability.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const starting = flow.start();
    await vi.waitFor(() => expect(mock.checkCardAvailability).toHaveBeenCalledOnce());
    const previous = storedSettings.value;
    storedSettings.value = {
      ...settings,
      connectionProfileId: '11111111-1111-4111-8111-111111111111',
      connectorUrl: 'http://127.0.0.1:55444'
    };
    release();
    await starting;
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.startDirectPayment).not.toHaveBeenCalled();
    expect(flow.busy.value).toBe(false);
    expect(flow.error.value).toContain('连接配置已变化');
    expect(flow.details.value.cvc).toBe('123');
    storedSettings.value = previous;
  });
  it('旧周期人工核实阶段不沿用普通人工验证继续入口', async () => {
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'next_subscription_cycle_review',
        user_action_required: true,
        cycle_review: {
          protocol: 1,
          status: 'awaiting_previous_cycle_confirmation',
          reviewDigest: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 300_000).toISOString()
        }
      })
    ];
    expect(flow.needsHuman.value).toBe(false);
    expect(flow.workflowMessage.value).toContain('只读核实旧订阅周期');
    expect(flow.workflowMessage.value).not.toContain('银行验证');
    await flow.resume();
    expect(mock.connectorResume).not.toHaveBeenCalled();
  });
  it('账号密码只选择资料库账号，并使用受控 savedLogin，保留同账号 2FA', async () => {
    fillForm();
    await choosePasswordAccount(true, true);
    const savedLogin = {
      email: 'registered@example.com',
      password: 'synthetic-password',
      totp: {
        secret: 'SYNTHETIC_ONLY',
        algorithm: 'sha1',
        digits: 6,
        period: 30
      }
    };
    mock.startBitBrowser.mockImplementation(async (input) => ({
      ...launch,
      id: input.id,
      savedLogin
    }));
    await flow.start();
    expect(mock.startBitBrowser.mock.calls[0]![0]).toMatchObject({
      chatgptAccountId: 'account-fixture',
      useSavedCredentials: true
    });
    expect(mock.loginCredential).not.toHaveBeenCalled();
    expect(mock.startDirectPayment.mock.calls[0]![0].credential.login).toEqual({
      email: savedLogin.email,
      password: savedLogin.password
    });
    expect(mock.startDirectPayment.mock.calls[0]![0].credential.login).not.toHaveProperty('totp');
  });
  it('无密码账号使用邮箱验证码启动，历史 Go 和未知套餐仍先核对官网', async () => {
    fillForm();
    await choosePasswordAccount(false);
    expect(flow.canStart.value).toBe(true);
    bankAccounts.value.items = [{ ...account(), subscriptionState: 'unknown' }];
    expect(flow.savedBankAccounts.value).toHaveLength(1);
    expect(flow.canStart.value).toBe(true);
  });
  it('同账号升级仅转发 API 证明的成功窗口归属，不由页面猜测窗口', async () => {
    fillForm();
    await choosePasswordAccount();
    const ownedProfile = {
      sourceJobId: 'prior-success',
      profileId: 'owned-window',
      accountKey: 'd'.repeat(64)
    };
    mock.startBitBrowser.mockImplementation(async (input) => ({
      ...launch,
      id: input.id,
      ownedProfile
    }));
    await flow.start();
    expect(mock.startDirectPayment.mock.calls[0]![0].launch.ownedProfile).toEqual(ownedProfile);
    expect(mock.startBitBrowser.mock.calls[0]![0]).not.toHaveProperty('ownedProfile');
  });
  it('账户资料读取迟到不能覆盖已切换账号的邮箱', async () => {
    let release: (value: { email: string }) => void = () => {};
    mock.accountIdentity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    bankAccounts.value.items = [account(), { ...account(), id: 'account-b' }];
    flow.loginMethod.value = 'password';
    flow.selectedBankAccountId.value = 'account-fixture';
    await nextTick();
    flow.selectedBankAccountId.value = 'account-b';
    await nextTick();
    await nextTick();
    release({ email: 'late@example.invalid' });
    await nextTick();
    expect(flow.selectedBankAccountEmail.value).toBe('registered@example.com');
  });
  it('网页控制器明确未接收时安全结束原任务，不重发且保留付款资料', async () => {
    fillForm();
    mock.startDirectPayment.mockRejectedValueOnce(
      new Error('fixture browser controller unavailable')
    );
    await flow.start();
    expect(mock.abandonUnreceivedBitBrowser).toHaveBeenCalledOnce();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.error.value).toContain('fixture browser controller unavailable');
    expect(mock.startDirectPayment).toHaveBeenCalledOnce();
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });
  it('网页已接收但列表还未回读时不重发同一任务或释放付款锁', async () => {
    fillForm();
    mock.startDirectPayment.mockImplementationOnce(async (input) => {
      mock.paymentControls.set(input.launch.id, { pending: false });
    });
    await flow.start();
    await flow.start();
    expect(mock.startDirectPayment).toHaveBeenCalledOnce();
    expect(mock.startBitBrowser).toHaveBeenCalledOnce();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('');
  });
  it('未知付款只允许复查原单，不重新充值', async () => {
    fillForm();
    bankAccounts.value.items = [account()];
    flow.loginMethod.value = 'password';
    flow.selectedBankAccountId.value = 'account-fixture';
    await nextTick();
    await nextTick();
    jobs.value.items = [
      job('unknown', {
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_status: 'unknown'
      })
    ];
    expect(flow.canStart.value).toBe(false);
    expect(flow.canRecheck.value).toBe(true);
    expect(flow.workflowMessage.value).toContain('禁止重新付款');
  });
  it('旧助手原单也由网页只读复查，不读取55322或重新发送卡资料', async () => {
    fillForm();
    const source = job('unknown', {
      transport: 'official_browser',
      checkout_identifier: 'oaics_historical',
      payment_attempted: true,
      payment_requests_sent: 1,
      payment_status: 'unknown'
    });
    jobs.value.items = [source];
    flow.selectJob(source.id);
    expect(flow.canRecheck.value).toBe(true);
    await flow.recheck();
    expect(mock.recheckBitBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        directMode: true,
        sourceJobId: source.id,
        plan: source.plan
      })
    );
    expect(mock.startDirectPayment).toHaveBeenCalledOnce();
    expect(mock.startDirectPayment.mock.calls[0]![0]).toMatchObject({
      recheck: source.result,
      payment: { number: '', cvc: '' },
      launch: { transport: 'web_direct' }
    });
    expect(mock.preparePaymentCard).not.toHaveBeenCalled();
    expect(mock.connectorHealth).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('');
  });
  it('旧原单复查回执未启用网页协议时不降级给助手或重新建单', async () => {
    fillForm();
    jobs.value.items = [
      job('unknown', {
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_status: 'unknown'
      })
    ];
    mock.recheckBitBrowser.mockResolvedValueOnce({ ...launch, mode: 'recheck' });
    await flow.recheck(jobs.value.items[0]);
    expect(mock.recheckBitBrowser).toHaveBeenCalledOnce();
    expect(mock.startDirectPayment).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('不会新建订单或重复付款');
  });
  it('旧原单确认未收到银行请求由服务端处理，保留原单和核验绑定且不访问助手', async () => {
    const source = job('unknown', {
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      payment_status: 'unknown',
      resolution_verification_job_id: resolutionLaunch.verificationJobId
    });
    jobs.value.items = [source];
    flow.selectJob(source.id);
    expect(flow.canResolveNoBankRequest.value).toBe(true);
    await flow.resolveNoBankRequest();
    expect(mock.confirmResolution).toHaveBeenCalledOnce();
    expect(mock.resolveNoBankRequest).toHaveBeenCalledWith(source.id, {
      directMode: true,
      confirmNoBankRequest: true,
      verificationJobId: resolutionLaunch.verificationJobId
    });
    expect(mock.connectorHealth).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.startDirectPayment).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('');
  });
  it('查看旧失败单不限制其他账号，切回同账号才限制新付款，仍允许仅登录', async () => {
    fillForm();
    await choosePasswordAccount();
    expect(flow.canStart.value).toBe(true);
    jobs.value.items = [
      {
        ...job('finished', {
          payment_attempted: true,
          payment_requests_sent: 1,
          payment_status: 'unknown'
        }),
        chatgptAccountId: 'other-account',
        availability: {
          execution: 'released',
          payment: 'unknown',
          accountPaymentRestricted: true,
          canInspect: true
        }
      }
    ];
    flow.selectJob('job-fixture');
    expect(flow.selectedBankAccountId.value).toBe('account-fixture');
    expect(flow.canStart.value).toBe(true);
    expect(flow.canStartOpen.value).toBe(true);
    jobs.value.items[0]!.chatgptAccountId = 'account-fixture';
    expect(flow.canStart.value).toBe(false);
    expect(flow.canStartOpen.value).toBe(true);
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.details.value.cvc).toBe('123');
  });
  it('目标升级已核实但付款未知时只提示只读复查，保留原付款锁', async () => {
    fillForm();
    bankAccounts.value.items = [account()];
    flow.loginMethod.value = 'password';
    flow.selectedBankAccountId.value = 'account-fixture';
    await nextTick();
    await nextTick();
    for (const state of ['unknown', 'finished'] as const) {
      for (const [plan, current] of [
        ['plus', 'plus'],
        ['pro-5x', 'pro'],
        ['pro-20x', 'pro'],
        ['pro-500', 'promax']
      ] as const) {
        jobs.value.items = [
          {
            ...job(state, {
              status: 'uncertain',
              operation: 'subscription_upgrade',
              account_matched: true,
              payment_attempted: true,
              payment_requests_sent: 1,
              payment_status: 'unknown',
              subscription_status: plan,
              current_plan: current
            }),
            plan
          }
        ];
        flow.selectJob('job-fixture');
        expect(flow.workflowMessage.value).toBe(
          '套餐已核实生效，付款凭据待核验；请只读复查原订单，禁止重新付款。'
        );
        expect(flow.canStart.value).toBe(false);
        expect(flow.canRecheck.value).toBe(true);
        expect(flow.canContinueSameAccount.value).toBe(false);
      }
    }
  });
  it('付款与精确目标套餐均核实的升级保留原成功提示', () => {
    jobs.value.items = [
      {
        ...job('finished', {
          status: 'subscription_activated',
          operation: 'subscription_upgrade',
          account_matched: true,
          payment_attempted: true,
          payment_requests_sent: 1,
          payment_status: 'paid',
          payment_outcome: 'subscription_activated',
          subscription_status: 'pro-20x',
          current_plan: 'pro'
        }),
        plan: 'pro-20x'
      }
    ];
    flow.selectJob('job-fixture');
    expect(flow.workflowMessage.value).toBe(
      '付款与套餐生效均已核实；可继续为同一账号选择下一套餐。'
    );
  });
  it('错误档位、账号不符或非升级原单不能展示套餐已核实提示', async () => {
    fillForm();
    bankAccounts.value.items = [account()];
    flow.loginMethod.value = 'password';
    flow.selectedBankAccountId.value = 'account-fixture';
    await nextTick();
    await nextTick();
    const cases: Array<{
      plan?: V2RechargeJob['plan'];
      result: Partial<V2RechargeJob['result']>;
    }> = [
      { result: { subscription_status: 'pro-5x' } },
      { result: { subscription_status: 'pro' } },
      { result: { subscription_status: undefined } },
      { result: { current_plan: 'plus' } },
      { result: { current_plan: 'promax' } },
      { result: { account_matched: false } },
      { result: { operation: undefined } },
      { result: { payment_attempted: false } },
      { plan: 'pro-500', result: { subscription_status: 'pro-500', current_plan: 'pro' } }
    ];
    for (const state of ['unknown', 'finished'] as const) {
      for (const fixture of cases) {
        jobs.value.items = [
          {
            ...job(state, {
              status: 'uncertain',
              operation: 'subscription_upgrade',
              account_matched: true,
              payment_attempted: true,
              payment_requests_sent: 1,
              payment_status: 'unknown',
              subscription_status: 'pro-20x',
              current_plan: 'pro',
              ...fixture.result
            }),
            plan: fixture.plan ?? 'pro-20x'
          }
        ];
        flow.selectJob('job-fixture');
        expect(flow.workflowMessage.value).not.toContain('套餐已核实生效');
        expect(flow.canStart.value).toBe(false);
        expect(flow.canRecheck.value).toBe(true);
        expect(flow.canContinueSameAccount.value).toBe(false);
      }
    }
  });
  it('明确银行结果或已有付款凭据时不展示付款未知的升级提示', () => {
    fillForm();
    const cases: Array<Partial<V2RechargeJob['result']>> = [
      { payment_status: 'declined' },
      { payment_status: 'requires_action' },
      { payment_status: 'not_attempted' },
      {
        payment_status: 'unknown',
        payment_evidence: { kind: 'invoice', identifier: 'synthetic-evidence' }
      }
    ];
    for (const state of ['unknown', 'finished'] as const) {
      for (const result of cases) {
        jobs.value.items = [
          {
            ...job(state, {
              status: 'uncertain',
              operation: 'subscription_upgrade',
              account_matched: true,
              payment_attempted: true,
              payment_requests_sent: 1,
              subscription_status: 'pro-20x',
              current_plan: 'pro',
              ...result
            }),
            plan: 'pro-20x'
          }
        ];
        flow.selectJob('job-fixture');
        expect(flow.workflowMessage.value).not.toContain('套餐已核实生效');
        expect(flow.canRecheck.value).toBe(true);
        expect(flow.canContinueSameAccount.value).toBe(false);
      }
    }
  });
  it('确认暂停时允许编辑草稿，保留原任务确认并禁止重复启动', () => {
    jobs.value.items = [job('awaiting_confirmation', { quote_digest: 'fixture-digest' })];
    expect(flow.formLocked.value).toBe(false);
    expect(flow.canStart.value).toBe(false);
    expect(flow.canStartOpen.value).toBe(false);
    expect(mock.jobOptions?.getRevalidateAt?.(jobs.value)).toBeGreaterThan(Date.now());
    expect(flow.workflowMessage.value).toContain('核对金额');
  });
  it('本页拥有网页付款任务时显示核价确认，不误报其他网页的登录任务', () => {
    mock.paymentOwns.mockReturnValue(true);
    jobs.value.items = [
      job('awaiting_confirmation', { transport: 'web_direct', quote_digest: 'fixture-digest' })
    ];
    expect(flow.workflowMessage.value).toContain('核对金额');
    expect(flow.workflowMessage.value).not.toContain('原网页');
  });
  it('本页拥有正在运行的网页付款任务时显示当前执行状态', () => {
    mock.paymentOwns.mockReturnValue(true);
    jobs.value.items = [job('running', { transport: 'web_direct', mode: 'payment' })];
    expect(flow.workflowMessage.value).toContain('核实官网状态');
    expect(flow.workflowMessage.value).not.toContain('原网页');
  });
  it('已是目标套餐说明无需重复付款', () => {
    jobs.value.items = [
      job('finished', { status: 'already_subscribed', payment_attempted: false })
    ];
    flow.selectJob('job-fixture');
    expect(flow.workflowMessage.value).toContain('未提交付款');
    expect(flow.canContinueSameAccount.value).toBe(false);
  });
  it('成功回执保留账号、地址和窗名，清除敏感授权，下一次建立新任务', async () => {
    fillForm();
    await choosePasswordAccount();
    const fixtureLogin = { email: 'registered@example.com', password: 'synthetic-password' };
    mock.startBitBrowser.mockImplementation(async (input) => ({
      ...launch,
      id: input.id,
      savedLogin: fixtureLogin
    }));
    await flow.start();
    mock.clearPaymentValidation.mockImplementation(() => {
      expect(flow.details.value.cvc).toBe('');
      expect(flow.resettingPaymentFields.value).toBe(true);
    });
    const id = mock.startBitBrowser.mock.calls[0]![0].id;
    jobs.value.items = [
      {
        ...job('finished', {
          status: 'subscription_activated',
          payment_status: 'paid',
          payment_outcome: 'subscription_activated',
          payment_attempted: true,
          payment_requests_sent: 1,
          account_matched: true
        }),
        id
      }
    ];
    await nextTick();
    await nextTick();
    expect(mock.clearPaymentValidation).toHaveBeenCalledOnce();
    expect(flow.resettingPaymentFields.value).toBe(false);
    expect(flow.selectedBankAccountId.value).toBe('account-fixture');
    expect(flow.selectedAddressId.value).toBe(address.id);
    expect(flow.windowName.value).toBe('申请gpt-001');
    expect(flow.details.value.cvc).toBe('');
    expect(flow.sessionJson.value).toBe('');
    expect(flow.authorizeSinglePayment.value).toBe(false);
    expect(flow.canContinueSameAccount.value).toBe(true);
    flow.continueSameAccount();
    expect(flow.plan.value).toBe('plus');
    expect(flow.selected.value).toBeUndefined();
    Object.assign(flow.details.value, { number: '5555555555554444', expiry: '12/30', cvc: '123' });
    flow.authorizeSinglePayment.value = true;
    await flow.start();
    expect(mock.startBitBrowser).toHaveBeenCalledTimes(2);
    expect(mock.startBitBrowser.mock.calls[1]![0].id).not.toBe(id);
    expect(mock.startBitBrowser.mock.calls[1]![0].chatgptAccountId).toBe('account-fixture');
  });
  it('仅付款成功、未核实套餐生效时不能显示继续升级', () => {
    jobs.value.items = [
      job('finished', { status: 'paid_pending_activation', payment_status: 'paid' })
    ];
    flow.selectJob('job-fixture');
    expect(flow.canContinueSameAccount.value).toBe(false);
  });
  it('失败或迟到成功回执不清除新的表单输入和校验状态', async () => {
    fillForm();
    await flow.start();
    const id = mock.startBitBrowser.mock.calls[0]![0].id;
    flow.details.value.name = 'New draft name';
    jobs.value.items = [
      {
        ...job('finished', {
          status: 'subscription_activated',
          payment_status: 'paid',
          payment_outcome: 'subscription_activated',
          payment_attempted: true,
          payment_requests_sent: 1,
          account_matched: true
        }),
        id
      }
    ];
    await nextTick();
    await nextTick();
    expect(mock.clearPaymentValidation).not.toHaveBeenCalled();
    expect(flow.details.value.name).toBe('New draft name');
    expect(flow.resettingPaymentFields.value).toBe(false);
  });
  it('切页回归恢复资料库账号选择与非敏感草稿，安全码和当次授权不保留', async () => {
    fillForm();
    await choosePasswordAccount();
    scope.stop();
    scope = effectScope();
    flow = scope.run(useAutoRecharge)!;
    expect(flow.loginMethod.value).toBe('password');
    expect(flow.selectedBankAccountId.value).toBe('account-fixture');
    expect(flow.windowName.value).toBe('申请gpt-001');
    expect(flow.details.value.cvc).toBe('');
    expect(flow.authorizeSinglePayment.value).toBe(false);
  });
  it('旧草稿的最高金额不再恢复或阻止启动，安全码和当次授权仍重新填写', () => {
    fillForm();
    const legacy = scope.run(() =>
      useV2FormDraft('auto-recharge-form', () => ({ maxAmount: '30.00' }))
    )!;
    legacy.open('new');
    legacy.form.maxAmount = '30.001';
    scope.stop();
    scope = effectScope();
    mock.queryIndex = 0;
    flow = scope.run(useAutoRecharge)!;
    expect(flow).not.toHaveProperty('maxAmount');
    expect(flow.details.value.cvc).toBe('');
    expect(flow.authorizeSinglePayment.value).toBe(false);
    fillForm();
    expect(flow.canStart.value).toBe(true);
  });
  it('辅助登录不创建付款任务或传安全码', async () => {
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(directSessionJson());
    expect(flow.canStartOpen.value).toBe(true);
    await flow.startOpen();
    expect(mock.directStart).toHaveBeenCalledOnce();
    expect(mock.startBitBrowserOpen.mock.calls[0]![0]).toMatchObject({ directMode: true });
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });
  it('登录启动完成后页面读取一直挂起也释放按钮，重复刷新合并一次补读', async () => {
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(directSessionJson());
    let release!: () => void;
    const read = new Promise<void>((resolve) => (release = resolve));
    const refresh = mock.jobsQuery.refresh as ReturnType<typeof vi.fn>;
    refresh.mockReturnValueOnce(read).mockResolvedValue(undefined);
    await flow.startOpen();
    expect(flow.busy.value).toBe(false);
    expect(mock.directStart).toHaveBeenCalledOnce();
    const first = flow.refresh();
    const second = flow.refresh();
    expect(refresh).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('网页拥有的任务取消由同一生命周期收尾，不能因旧列表未刷新再取消一次', async () => {
    flow.operationMode.value = 'open_browser';
    jobs.value.items = [job('running', { mode: 'open_browser', transport: 'web_direct' })];
    flow.selectJob('job-fixture');
    mock.directOwns.mockReturnValue(true);
    expect(flow.canCancel.value).toBe(true);
    await flow.cancel();
    expect(mock.directCancel).toHaveBeenCalledExactlyOnceWith('job-fixture');
    expect(mock.cancelBitBrowser).not.toHaveBeenCalled();
    expect(flow.busy.value).toBe(false);
  });
  it('原任务已接管而首次进度及页面读取仍挂起时停止按钮可用，取消只收尾一次', async () => {
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(directSessionJson());
    let rejectStarted!: (cause: unknown) => void;
    const started = new Promise<void>((_resolve, reject) => (rejectStarted = reject));
    mock.directStart.mockImplementationOnce(() => {
      mock.directRunning!.value = true;
      mock.directOwns.mockReturnValue(true);
      mock.directHandles.mockReturnValue(true);
      return started;
    });
    const starting = flow.startOpen();
    await vi.waitFor(() => expect(mock.directStart).toHaveBeenCalledOnce());
    const id = mock.startBitBrowserOpen.mock.calls[0]?.[0].id;
    expect(jobs.value.items).toEqual([]);
    expect(flow.selected.value?.id).toBe(id);
    expect(flow.selected.value?.result).toMatchObject({
      mode: 'open_browser',
      transport: 'web_direct',
      payment_attempted: false
    });
    expect(flow.canCancel.value).toBe(true);
    expect(flow.busy.value).toBe(false);
    mock.directCancel.mockImplementationOnce(async () => {
      rejectStarted(new DirectBrowserError('bitbrowser_direct_cancelled'));
      await Promise.resolve();
      // 启动的 finally 不能在取消收尾期间提前开放按钮。
      expect(flow.busy.value).toBe(true);
      mock.directOwns.mockReturnValue(false);
      mock.directRunning!.value = false;
    });
    await flow.cancel();
    await starting;
    expect(mock.directCancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(mock.cancelBitBrowser).not.toHaveBeenCalled();
    expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
    expect(flow.busy.value).toBe(false);
  });
  it('页面销毁后迟到的启动响应未被接管时仍释放原任务', async () => {
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(directSessionJson());
    let resolveLaunch!: (value: typeof launch) => void;
    mock.startBitBrowserOpen.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLaunch = resolve))
    );
    const starting = flow.startOpen();
    await vi.waitFor(() => expect(mock.startBitBrowserOpen).toHaveBeenCalledOnce());
    scope.stop();
    mock.directStart.mockRejectedValueOnce(new DirectBrowserError('bitbrowser_direct_cancelled'));
    resolveLaunch(structuredClone(launch));
    await starting;
    expect(mock.abandonUnreceivedBitBrowser).toHaveBeenCalledOnce();
    expect(flow.selected.value).toBeUndefined();
    expect(mock.cancelBitBrowser).not.toHaveBeenCalled();
  });
  it('预检期间切换员工身份后旧点击不能创建任务、覆盖连接状态或释放新操作忙状态', async () => {
    flow.operationMode.value = 'open_browser';
    flow.updateJsonInput(directSessionJson());
    let release!: (value: unknown) => void;
    mock.directCatalog.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const starting = flow.startOpen();
    await vi.waitFor(() => expect(mock.directCatalog).toHaveBeenCalledOnce());
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    flow.error.value = '新身份的操作提示';
    flow.connectorStatus.value = 'offline';
    flow.connectorMessage.value = '新身份的连接提示';
    flow.busy.value = true;
    const refresh = mock.jobsQuery.refresh as ReturnType<typeof vi.fn>;
    const reads = refresh.mock.calls.length;
    release({
      groups: [{ id: 'group-direct', name: settings.groupName }],
      tags: [{ id: 'tag-direct', name: settings.tagName }]
    });
    await starting;
    expect(mock.startBitBrowserOpen).not.toHaveBeenCalled();
    expect(mock.loginCredential).not.toHaveBeenCalled();
    expect(mock.directStart).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('新身份的操作提示');
    expect(flow.connectorStatus.value).toBe('offline');
    expect(flow.connectorMessage.value).toBe('新身份的连接提示');
    expect(flow.busy.value).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(reads);
  });
  it('读取密码期间切换员工身份后不得创建任务或接管旧凭据', async () => {
    await choosePasswordAccount(true, false);
    flow.operationMode.value = 'open_browser';
    let release!: (value: { email: string; password: string }) => void;
    mock.loginCredential.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    );
    const starting = flow.startOpen();
    await vi.waitFor(() => expect(mock.loginCredential).toHaveBeenCalledOnce());
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    flow.error.value = '新身份提示';
    flow.busy.value = true;
    const refresh = mock.jobsQuery.refresh as ReturnType<typeof vi.fn>;
    const reads = refresh.mock.calls.length;
    release({ email: 'fixture@example.com', password: 'fixture-only-password' });
    await starting;
    expect(mock.startBitBrowserOpen).not.toHaveBeenCalled();
    expect(mock.directStart).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('新身份提示');
    expect(flow.busy.value).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(reads);
  });
  it.each([false, true])(
    '启动API已接受后切身份，旧回执清理失败=%s也不能覆盖新身份的选中任务、错误或忙状态',
    async (cleanupFails) => {
      flow.operationMode.value = 'open_browser';
      flow.updateJsonInput(directSessionJson());
      let release!: (value: unknown) => void;
      mock.startBitBrowserOpen.mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve))
      );
      const starting = flow.startOpen();
      await vi.waitFor(() => expect(mock.startBitBrowserOpen).toHaveBeenCalledOnce());
      const oldId = mock.startBitBrowserOpen.mock.calls[0]?.[0].id;
      const original = structuredClone({ ...launch, id: oldId, mode: 'open_browser' });
      const originalToken = original.agentToken;
      sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
      jobs.value.items = [{ ...job('finished'), id: 'new-user-job' }];
      flow.selectJob('new-user-job');
      flow.error.value = '新身份提示';
      flow.connectorStatus.value = 'offline';
      flow.connectorMessage.value = '新身份连接';
      flow.busy.value = true;
      const refresh = mock.jobsQuery.refresh as ReturnType<typeof vi.fn>;
      const reads = refresh.mock.calls.length;
      if (cleanupFails) mock.directBrowserCallback.mockRejectedValueOnce(new Error('已结束'));
      release(original);
      await starting;
      expect(mock.directStart).not.toHaveBeenCalled();
      expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
      expect(mock.directBrowserCallback).toHaveBeenCalledExactlyOnceWith(
        oldId,
        originalToken,
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
        { signal: expect.any(AbortSignal) }
      );
      expect(original.agentToken).toBe('');
      expect(original.bitBrowser.localApiToken).toBe('');
      expect(flow.selected.value?.id).toBe('new-user-job');
      expect(flow.error.value).toBe('新身份提示');
      expect(flow.connectorStatus.value).toBe('offline');
      expect(flow.connectorMessage.value).toBe('新身份连接');
      expect(flow.busy.value).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(reads);
    }
  );
  it('账号密码辅助登录传已选账号引用以恢复所属窗口，不向启动接口传密码', async () => {
    await choosePasswordAccount(true, false);
    flow.operationMode.value = 'open_browser';
    await flow.startOpen();
    expect(mock.startBitBrowserOpen).toHaveBeenCalledOnce();
    const input = mock.startBitBrowserOpen.mock.calls[0]![0];
    expect(input).toMatchObject({
      directMode: true,
      chatgptAccountId: flow.selectedBankAccountId.value
    });
    expect(input).not.toHaveProperty('login');
    expect(input).not.toHaveProperty('password');
    expect(mock.directStart.mock.calls[0]?.[1]).toMatchObject({
      login: { email: expect.any(String) }
    });
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });
  it('自动验证码只发向任务绑定的账号和挑战，重复刷新不重复提交', async () => {
    await choosePasswordAccount(true, true);
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'totp',
        login_challenge_id: 'challenge-totp'
      })
    ];
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledOnce());
    expect(mock.automaticLoginCode).toHaveBeenCalledWith(
      'job-fixture',
      'account-fixture',
      { kind: 'totp', challengeId: 'challenge-totp' },
      expect.any(AbortSignal)
    );
    expect(mock.connectorSubmitCode.mock.calls[0]?.[5]).toMatchObject({
      kind: 'totp',
      challengeId: 'challenge-totp'
    });
    flow.retryAutomaticCode();
    await nextTick();
    expect(mock.connectorSubmitCode).toHaveBeenCalledOnce();
  });
  it('无密码和无2FA账号可自动读取邮箱验证码', async () => {
    await choosePasswordAccount(false, false);
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'email',
        login_challenge_id: 'challenge-email'
      })
    ];
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledOnce());
    expect(mock.automaticLoginCode.mock.calls[0]?.[2]).toEqual({
      kind: 'email',
      challengeId: 'challenge-email'
    });
    expect(mock.accountTotpCode).not.toHaveBeenCalled();
  });
  it('邮箱验证码后出现2FA时，分别按新挑战各提交一次', async () => {
    await choosePasswordAccount(true, true);
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'email',
        login_challenge_id: 'challenge-email'
      })
    ];
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledOnce());
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'totp',
        login_challenge_id: 'challenge-totp'
      })
    ];
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledTimes(2));
    expect(mock.connectorSubmitCode.mock.calls.map((call) => call[5].kind)).toEqual([
      'email',
      'totp'
    ]);
  });
  it('网页直连由所属登录流程取码，页面观察器不再重复取码或发给连接器', async () => {
    await choosePasswordAccount(true, true);
    mock.directOwns.mockReturnValue(true);
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        transport: 'web_direct',
        login_code_type: 'totp',
        login_challenge_id: 'challenge'
      })
    ];
    await nextTick();
    expect(mock.automaticLoginCode).not.toHaveBeenCalled();
    expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
  });
  it.each(['task', 'account', 'cancel', 'dispose'])(
    '等待取码期间%s改变时停止提交，丢弃迟到响应',
    async (change) => {
      await choosePasswordAccount(true, true);
      let resolve!: (value: { token: string; expiresAt: string }) => void;
      mock.automaticLoginCode.mockImplementationOnce(
        () =>
          new Promise((accept) => {
            resolve = accept;
          })
      );
      jobs.value.items = [
        job('awaiting_human_verification', {
          stage: 'login_code_required',
          login_code_type: 'totp',
          login_challenge_id: 'challenge'
        })
      ];
      await vi.waitFor(() => expect(mock.automaticLoginCode).toHaveBeenCalledOnce());
      if (change === 'task') jobs.value.items = [];
      else if (change === 'account') flow.selectedBankAccountId.value = 'other-account';
      else if (change === 'cancel') await flow.cancel();
      else scope.stop();
      await nextTick();
      resolve({ token: '123456', expiresAt: new Date(Date.now() + 30_000).toISOString() });
      await nextTick();
      expect(mock.automaticLoginCode.mock.calls[0]?.[3].aborted).toBe(true);
      expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
    }
  );
  it('取码失败时保留手动输入，自动刷新不会循环领取', async () => {
    await choosePasswordAccount(true, true);
    mock.automaticLoginCode.mockRejectedValueOnce(new Error('等待超时，请在原窗口继续'));
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'totp',
        login_challenge_id: 'challenge'
      })
    ];
    await vi.waitFor(() => expect(flow.needsManualCode.value).toBe(true));
    expect(mock.automaticLoginCode).toHaveBeenCalledOnce();
    expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
  });
  it('已选账号与原任务绑定不同账号时不自动取码', async () => {
    await choosePasswordAccount(true, true);
    jobs.value.items = [
      {
        ...job('awaiting_human_verification', {
          stage: 'login_code_required',
          login_code_type: 'totp',
          login_challenge_id: 'challenge'
        }),
        chatgptAccountId: 'other'
      }
    ];
    await nextTick();
    expect(mock.automaticLoginCode).not.toHaveBeenCalled();
    expect(flow.needsManualCode.value).toBe(true);
  });
  it('连接资料等待耗尽验证码有效期时不再发往连接器', async () => {
    vi.useFakeTimers();
    await choosePasswordAccount(true, true);
    mock.automaticLoginCode.mockResolvedValueOnce({
      token: '123456',
      expiresAt: new Date(Date.now() + 10_000).toISOString()
    });
    mock.bitBrowserAccess.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { connectorUrl: settings.connectorUrl, connectorToken: launch.connectorToken };
    });
    jobs.value.items = [
      job('awaiting_human_verification', {
        stage: 'login_code_required',
        login_code_type: 'totp',
        login_challenge_id: 'challenge'
      })
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('有效时间不足');
  });
  it('人工验证恢复丢失响应时先查原状态，不重复发继续', async () => {
    jobs.value.items = [job('awaiting_human_verification', { stage: 'three_ds' })];
    mock.connectorResume.mockRejectedValueOnce(new Error('fixture response lost'));
    await flow.resume();
    expect(mock.connectorResume).toHaveBeenCalledOnce();
    expect(mock.connectorStatus).toHaveBeenCalledOnce();
  });
  it('历史服务器记录可查看和停止，不改变比特操作入口', async () => {
    jobs.value.items = [{ ...job('running'), action: 'server' }];
    flow.selectJob('job-fixture');
    expect(flow.operationMode.value).toBe('payment');
    expect(flow.canRecheck.value).toBe(false);
    await flow.cancel();
    expect(mock.cancelServer).toHaveBeenCalledOnce();
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });
  it('已有比特窗口选项保持默认归一化能力', () => {
    expect(V2_RECHARGE_BROWSER_DEFAULTS.syncCookies).toBe(false);
    expect(V2_RECHARGE_BROWSER_DEFAULTS.syncLocalStorage).toBe(false);
  });
});
