import { effectScope, nextTick, ref } from 'vue';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  V2RechargeAddress,
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserResolutionLaunch,
  V2RechargeBitBrowserSettings,
  V2RechargeJob
} from './contracts';
import { RechargeConnectorError } from './connector-transport';
import { useAutoRecharge } from './useAutoRecharge';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';

const mock = vi.hoisted(() => ({
  jobsQuery: {} as Record<string, unknown>,
  addressesQuery: {} as Record<string, unknown>,
  settingsQuery: {} as Record<string, unknown>,
  serverProxySettingsQuery: {} as Record<string, unknown>,
  defaultProxyCatalogQuery: {} as Record<string, unknown>,
  totpQuery: {} as Record<string, unknown>,
  bankAccountsQuery: {} as Record<string, unknown>,
  bankCurrenciesQuery: {} as Record<string, unknown>,
  paymentCapsQuery: {} as Record<string, unknown>,
  paymentCardsQuery: {} as Record<string, unknown>,
  proxyCountriesQuery: {} as Record<string, unknown>,
  proxiesQuery: {} as Record<string, unknown>,
  checkCardAvailability: vi.fn(),
  managedCardDetail: vi.fn(),
  accountIdentity: vi.fn(),
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
  callbackUrl: vi.fn((id: string) => `https://admin.example/api/local/${id}`),
  confirmResolution: vi.fn()
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
    if (options.key === 'auto-recharge-payment-caps') return mock.paymentCapsQuery;
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
    getBitBrowserSettings: vi.fn(),
    getServerProxySettings: vi.fn(),
    updateServerProxySettings: mock.updateServerProxySettings,
    startBitBrowser: mock.startBitBrowser,
    startServer: mock.startServer,
    listPaymentCaps: vi.fn(),
    updatePaymentCap: vi.fn(),
    recheckServer: mock.recheckServer,
    cancelServer: mock.cancelServer,
    startBitBrowserOpen: mock.startBitBrowserOpen,
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
    listCards: vi.fn(),
    listAccounts: vi.fn(),
    listCurrencies: vi.fn(),
    managedCardDetail: mock.managedCardDetail,
    accountIdentity: mock.accountIdentity
  }
}));
vi.mock('./recharge-proxy-api', () => ({
  rechargeProxyApi: { countries: vi.fn(), list: vi.fn() }
}));
vi.mock('./useRechargeBrowserCatalog', () => ({
  useRechargeBrowserCatalog: () => ({ selectionError: ref('') }),
  readBrowserCatalog: mock.connectorCatalog
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
    maxAmount: '30.00',
    maxAmountMinor: 3000,
    authorizeSinglePayment: true
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

const jobs = ref<{ configured: boolean; items: V2RechargeJob[] }>({ configured: true, items: [] });
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
const bankAccounts = ref({ items: [] });
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
  mock.queryIndex = 0;
  jobs.value = { configured: true, items: [] };
  addresses.value.items = [address];
  savedTotp.value.items = [
    { id: '88888888-8888-4888-8888-888888888888', name: 'ChatGPT', issuer: 'OpenAI' }
  ];
  storedSettings.value = settings;
  phase.value = 'ready';
  mock.jobsQuery = queryResult(jobs);
  mock.addressesQuery = queryResult(addresses);
  mock.settingsQuery = queryResult(storedSettings);
  mock.serverProxySettingsQuery = queryResult(
    ref({ proxyId: null, proxy: null, legacyConfigured: false })
  );
  mock.defaultProxyCatalogQuery = queryResult(ref({ items: [] }));
  mock.totpQuery = queryResult(savedTotp);
  mock.bankAccountsQuery = queryResult(bankAccounts);
  mock.bankCurrenciesQuery = queryResult(bankCurrencies);
  mock.paymentCapsQuery = queryResult(
    ref({ items: [{ plan: 'plus', currencyCode: 'PHP', maxAmount: '1500' }] })
  );
  mock.paymentCardsQuery = queryResult(ref({ items: [] }));
  mock.proxyCountriesQuery = queryResult(ref({ items: [] }));
  mock.proxiesQuery = {
    ...queryResult(ref({ items: [], total: 0 })),
    ensureFresh: vi.fn().mockResolvedValue(undefined)
  };
  mock.checkCardAvailability.mockResolvedValue({ available: true });
  mock.managedCardDetail.mockReset().mockResolvedValue({
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
    connectorUrl: settings.connectorUrl,
    connectorToken: launch.connectorToken,
    agentToken: launch.agentToken,
    bitBrowser: launch.bitBrowser
  });
  mock.resolveNoBankRequest.mockResolvedValue(resolutionLaunch);
  mock.confirmResolution.mockResolvedValue('confirm');
  mock.connectorStart.mockResolvedValue({ ok: true, accepted: true });
  mock.connectorStatus.mockResolvedValue({ ok: true, done: false, waitingForUser: false });
  mock.connectorResume.mockResolvedValue({ ok: true });
  mock.connectorSubmitCode.mockResolvedValue({ ok: true });
  mock.connectorCancel.mockResolvedValue({ ok: true });
  mock.connectorHealth.mockResolvedValue({ ok: true });
  mock.connectorCatalog.mockResolvedValue({
    groups: [{ id: 'g', name: settings.groupName }],
    tags: [{ id: 't', name: settings.tagName }]
  });
  mock.cancelBitBrowser.mockResolvedValue({ id: launch.id });
  mock.abandonUnreceivedBitBrowser.mockResolvedValue({ id: launch.id });
  mock.bitBrowserAccess.mockResolvedValue({
    connectorUrl: settings.connectorUrl,
    connectorToken: launch.connectorToken
  });
  mock.updateBitBrowserSettings.mockResolvedValue(settings);
  scope = effectScope();
  flow = scope.run(useAutoRecharge)!;
  flow.operationMode.value = 'payment';
});

afterEach(() => scope.stop());

describe('充值地址自动选择', () => {
  const secondAddress: V2RechargeAddress = {
    ...address,
    id: '99999999-9999-4999-8999-999999999999',
    line1: '1054 SW Test Oak Avenue',
    createdAt: '2026-10-01T08:00:00Z'
  };

  it.each(['server_payment', 'payment'] as const)(
    '缓存地址就绪时立即在 %s 模式选中并回填',
    (mode) => {
      flow.operationMode.value = mode;
      expect(flow.selectedAddressId.value).toBe(address.id);
      expect(flow.selectedAddress.value).toEqual(address);
      expect(flow.details.value).toMatchObject({
        country: address.country,
        line1: address.line1,
        city: address.city,
        state: address.state,
        postal_code: address.postalCode
      });
    }
  );

  it('首次读取地址完成后自动选中，空目录保持空选择', () => {
    scope.stop();
    clearV2SessionDrafts();
    mock.queryIndex = 0;
    phase.value = 'initial-loading';
    addresses.value.items = [];
    scope = effectScope();
    flow = scope.run(useAutoRecharge)!;
    expect(flow.selectedAddressId.value).toBe('');
    addresses.value.items = [secondAddress];
    expect(flow.selectedAddressId.value).toBe('');
    phase.value = 'ready';
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
    addresses.value.items = [];
    expect(flow.selectedAddressId.value).toBe('');
    expect(flow.details.value.line1).toBe('');
  });

  it('本机排除已用及停用地址，按现有创建时间和编号顺序选中', () => {
    addresses.value.items = [
      { ...address, id: 'disabled', status: 'disabled' },
      { ...address, id: 'used', status: 'used', usedAt: '2026-09-30T08:00:00Z' },
      secondAddress,
      { ...secondAddress, id: 'a-earliest', createdAt: '2026-09-01T08:00:00Z' }
    ];
    expect(flow.selectedAddressId.value).toBe('a-earliest');
    expect(flow.availableAddresses.value.map((item) => item.id)).toEqual([
      'a-earliest',
      secondAddress.id
    ]);
  });

  it('服务器没有未使用地址时选择最久未用的一条，切回本机不使用已用地址', () => {
    flow.operationMode.value = 'server_payment';
    addresses.value.items = [
      { ...secondAddress, status: 'used', usedAt: '2026-09-30T08:00:00Z' },
      { ...address, status: 'used', usedAt: '2026-09-01T08:00:00Z' }
    ];
    expect(flow.selectedAddressId.value).toBe(address.id);
    expect(flow.availableAddresses.value.map((item) => item.id)).toEqual([
      address.id,
      secondAddress.id
    ]);
    flow.operationMode.value = 'payment';
    expect(flow.selectedAddressId.value).toBe('');
    expect(flow.selectedAddress.value).toBeUndefined();
  });

  it('手动选择后刷新与导航往返保留选项，不被排序靠前的新地址覆盖', () => {
    addresses.value.items = [address, secondAddress];
    flow.selectedAddressId.value = secondAddress.id;
    flow.markAddressSelectionManual();
    addresses.value.items = [secondAddress, { ...address }, { ...address, id: 'new-earliest' }];
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    scope.stop();
    mock.queryIndex = 0;
    scope = effectScope();
    flow = scope.run(useAutoRecharge)!;
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
  });

  it('手动选项停用后自动补选可用地址', () => {
    addresses.value.items = [address, secondAddress];
    flow.selectedAddressId.value = secondAddress.id;
    flow.markAddressSelectionManual();
    addresses.value.items = [address, { ...secondAddress, status: 'disabled' }];
    expect(flow.selectedAddressId.value).toBe(address.id);
    expect(flow.details.value.line1).toBe(address.line1);
  });

  it('读取中或读取失败时保留原选择与内容，成功后再重新匹配', () => {
    addresses.value.items = [address, secondAddress];
    flow.selectedAddressId.value = secondAddress.id;
    phase.value = 'refreshing';
    addresses.value.items = [];
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
    (mock.addressesQuery.error as { value: string | null }).value = '读取失败';
    phase.value = 'refresh-error';
    addresses.value.items = [address];
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
    (mock.addressesQuery.error as { value: string | null }).value = null;
    phase.value = 'ready';
    expect(flow.selectedAddressId.value).toBe(address.id);
  });

  it('临时手填内容不被地址目录刷新覆盖', () => {
    flow.operationMode.value = 'server_payment';
    flow.addressSource.value = 'manual';
    flow.markAddressSelectionManual();
    flow.details.value.line1 = 'Manual billing address';
    addresses.value.items = [secondAddress];
    expect(flow.details.value.line1).toBe('Manual billing address');
    flow.addressSource.value = 'library';
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
  });

  it('选择已保存银行卡时优先选中它的核实地址', async () => {
    addresses.value.items = [address, secondAddress];
    mock.managedCardDetail.mockResolvedValueOnce({
      id: 'card-a',
      status: 'active',
      currencyCode: 'PHP',
      number: '5555555555554444',
      expiry: '12/30',
      billingName: 'Test User',
      billingAddressId: secondAddress.id
    });
    await flow.selectSavedCard('card-a');
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
    expect(flow.details.value.name).toBe('Test User');
  });

  it('银行卡核实地址不可用时保持空选择，不能静默换成其他地址', async () => {
    addresses.value.items = [{ ...address, status: 'disabled' }, secondAddress];
    await flow.selectSavedCard('card-a');
    expect(flow.selectedAddressId.value).toBe('');
    expect(flow.selectedAddress.value).toBeUndefined();
    expect(flow.details.value.line1).toBe('');
    addresses.value.items = [address, secondAddress];
    expect(flow.selectedAddressId.value).toBe(address.id);
  });

  it('选卡详情晚到时不覆盖其间手动修改的地址', async () => {
    addresses.value.items = [address, secondAddress];
    let finish!: (value: unknown) => void;
    mock.managedCardDetail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = flow.selectSavedCard('card-a');
    flow.selectedAddressId.value = secondAddress.id;
    flow.markAddressSelectionManual();
    finish({
      id: 'card-a',
      status: 'active',
      currencyCode: 'PHP',
      number: '5555555555554444',
      expiry: '12/30',
      billingAddressId: address.id
    });
    await pending;
    expect(flow.selectedAddressId.value).toBe(secondAddress.id);
    expect(flow.details.value.line1).toBe(secondAddress.line1);
  });
});

describe('服务器默认代理关联', () => {
  const proxy = {
    id: '33333333-3333-4333-8333-333333333333',
    countryCode: 'PH',
    status: 'active',
    kind: 'dynamic_residential',
    protocol: 'socks5'
  };
  function setDefault(value: unknown) {
    (mock.serverProxySettingsQuery.data as { value: unknown }).value = value;
  }
  it('自动带入目录默认值，不被国家切换监听或账单国家覆盖', async () => {
    fillForm();
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['US', 'PH'] };
    (mock.proxiesQuery.data as { value: unknown }).value = { items: [proxy], total: 1 };
    setDefault({ proxyId: proxy.id, proxy, legacyConfigured: true });
    flow.operationMode.value = 'server_payment';
    await nextTick();
    expect(flow.selectedProxyCountryCode.value).toBe('PH');
    expect(flow.selectedProxyId.value).toBe(proxy.id);
    addresses.value.items = [{ ...address }];
    await nextTick();
    expect(flow.selectedProxyId.value).toBe(proxy.id);
    expect(flow.selectedAddress.value?.country).toBe('US');
    expect(flow.canStart.value).toBe(true);
  });
  it('刷新默认值保留手动选择，点击使用默认代理才替换', async () => {
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['US', 'PH'] };
    flow.operationMode.value = 'server_payment';
    flow.selectedProxyCountryCode.value = 'US';
    flow.selectedProxyId.value = 'manual-proxy';
    setDefault({ proxyId: proxy.id, proxy, legacyConfigured: false });
    await nextTick();
    expect(flow.selectedProxyId.value).toBe('manual-proxy');
    flow.useServerDefaultProxy();
    await nextTick();
    expect(flow.selectedProxyId.value).toBe(proxy.id);
  });
  it('手动确认同一默认编号后，修改默认值也不会覆盖本次选择', async () => {
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['PH', 'US'] };
    setDefault({ proxyId: proxy.id, proxy, legacyConfigured: false });
    flow.operationMode.value = 'server_payment';
    await nextTick();
    flow.markProxySelectionManual();
    setDefault({
      proxyId: 'next-default',
      proxy: { ...proxy, id: 'next-default', countryCode: 'US' },
      legacyConfigured: false
    });
    await nextTick();
    expect(flow.selectedProxyId.value).toBe(proxy.id);
    expect(flow.selectedProxyCountryCode.value).toBe('PH');
  });
  it('默认代理被停用时清除旧自动选择，空目录不能启动服务器任务', async () => {
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['PH'] };
    setDefault({ proxyId: proxy.id, proxy, legacyConfigured: false });
    flow.operationMode.value = 'server_payment';
    await nextTick();
    expect(flow.selectedProxyId.value).toBe(proxy.id);
    setDefault({
      proxyId: proxy.id,
      proxy: { ...proxy, status: 'disabled' },
      legacyConfigured: false
    });
    await nextTick();
    expect(flow.selectedProxyId.value).toBe('');
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: [] };
    fillForm();
    expect(flow.canStart.value).toBe(false);
    await flow.start();
    expect(mock.startServer).not.toHaveBeenCalled();
  });
  it('默认保存失败保留选择，成功后更新默认资料', async () => {
    (mock.defaultProxyCatalogQuery.data as { value: unknown }).value = { items: [proxy] };
    flow.serverProxySettings.setOpen(true);
    flow.serverProxySettings.proxyId.value = proxy.id;
    mock.updateServerProxySettings.mockRejectedValueOnce(new Error('保存失败'));
    await flow.serverProxySettings.save();
    expect(flow.serverProxySettings.open.value).toBe(true);
    expect(flow.serverProxySettings.proxyId.value).toBe(proxy.id);
    expect(flow.serverProxySettings.error.value).toBe('保存失败');
    mock.updateServerProxySettings.mockResolvedValueOnce({
      proxyId: proxy.id,
      proxy,
      legacyConfigured: false
    });
    await flow.serverProxySettings.save();
    expect(flow.serverProxySettings.open.value).toBe(false);
    expect(mock.updateServerProxySettings).toHaveBeenCalledWith(proxy.id);
  });
});

describe('本机比特浏览器自动充值', () => {
  it('先选国家再选择该国启用代理，并把代理编号传给充值任务', async () => {
    fillForm();
    const proxyId = '33333333-3333-4333-8333-333333333333';
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['US'] };
    expect(flow.canStart.value).toBe(false);
    flow.selectedProxyCountryCode.value = 'US';
    (mock.proxiesQuery.data as { value: unknown }).value = {
      items: [{ id: proxyId, countryCode: 'US', status: 'active', kind: 'dynamic_residential' }]
    };
    await nextTick();
    expect(flow.canStart.value).toBe(false);
    flow.selectedProxyId.value = proxyId;
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startBitBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyId,
        proxyCountryCode: 'US'
      })
    );
  });
  it('停用的已保存卡号在打开浏览器前被拦截', async () => {
    fillForm();
    mock.checkCardAvailability.mockRejectedValue(new Error('该银行卡已停用，不能用于充值'));
    await flow.start();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('已停用');
  });

  it('账号密码只发给本机连接器，服务端任务不含登录秘密', async () => {
    flow.loginMethod.value = 'password';
    flow.loginEmail.value = 'test@example.invalid';
    flow.loginPassword.value = 'local-password';
    flow.totp.secretInput.value = 'JBSWY3DPEHPK3PXP';
    await nextTick();
    flow.windowName.value = '申请gpt-001';
    flow.selectedAddressId.value = address.id;
    Object.assign(flow.details.value, {
      number: '5555555555554444',
      name: 'Test User',
      expiry: '12/30',
      cvc: '123'
    });
    flow.authorizeSinglePayment.value = true;
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    const serverBody = mock.startBitBrowser.mock.calls[0]![0];
    const localBody = mock.connectorStart.mock.calls[0]![2];
    expect(JSON.stringify(serverBody)).not.toContain('local-password');
    expect(serverBody).not.toHaveProperty('login');
    expect(localBody).toMatchObject({
      mode: 'payment',
      login: { email: 'test@example.invalid', password: 'local-password' }
    });
    expect(localBody).not.toHaveProperty('sessionJson');
    expect(JSON.stringify(localBody)).not.toContain('JBSWY3DPEHPK3PXP');
    expect(flow.loginPassword.value).toBe('local-password');
  });

  it('选择已保存 2FA 账号后，官网索取验证码时自动获取并仅向本机提交一次', async () => {
    flow.loginMethod.value = 'password';
    flow.totp.source.value = 'saved';
    flow.totp.savedAccountId.value = savedTotp.value.items[0]!.id;
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'awaiting_human_verification',
        result: { status: 'awaiting_human_verification', stage: 'login_code_required' },
        createdAt: '',
        updatedAt: ''
      }
    ];
    flow.selectJob(launch.id);
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledTimes(1));
    expect(mock.listTotpAccounts).toHaveBeenCalledTimes(1);
    expect(mock.connectorSubmitCode).toHaveBeenCalledWith(
      settings.connectorUrl,
      launch.connectorToken,
      launch.id,
      '123456'
    );
    expect(flow.needsManualCode.value).toBe(false);
    expect(mock.connectorResume).not.toHaveBeenCalled();
  });

  it('已保存 2FA 取码失败时停止自动提交并显示手动兜底', async () => {
    flow.loginMethod.value = 'password';
    flow.totp.source.value = 'saved';
    flow.totp.savedAccountId.value = savedTotp.value.items[0]!.id;
    mock.listTotpAccounts.mockRejectedValue(new Error('2FA 服务暂不可用'));
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'awaiting_human_verification',
        result: { status: 'awaiting_human_verification', stage: 'login_code_required' },
        createdAt: '',
        updatedAt: ''
      }
    ];
    flow.selectJob(launch.id);
    await vi.waitFor(() => expect(flow.needsManualCode.value).toBe(true));
    expect(flow.error.value).toBe('2FA 服务暂不可用');
    expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
  });

  it('当次 6 位验证码不能当作可自动生成的 2FA 密钥', () => {
    flow.loginMethod.value = 'password';
    flow.loginEmail.value = 'test@example.invalid';
    flow.loginPassword.value = 'local-password';
    flow.totp.secretInput.value = '123456';
    flow.windowName.value = '申请gpt-001';
    expect(flow.totp.ready.value).toBe(false);
    expect(flow.canStartOpen.value).toBe(false);
  });

  it('验证码只向正在等待的本机任务提交一次', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'awaiting_human_verification',
        result: { status: 'awaiting_human_verification', stage: 'login_code_required' },
        createdAt: '',
        updatedAt: ''
      }
    ];
    flow.selectJob(launch.id);
    await nextTick();
    expect(flow.needsCode.value).toBe(true);
    expect(flow.needsHuman.value).toBe(false);
    flow.loginCode.value = '123456';
    await flow.submitLoginCode();
    expect(mock.connectorSubmitCode).toHaveBeenCalledWith(
      settings.connectorUrl,
      launch.connectorToken,
      launch.id,
      '123456'
    );
    expect(mock.connectorResume).not.toHaveBeenCalled();
    expect(flow.loginCode.value).toBe('');
  });
  it('停止后清理中保持任务锁并说明进度，不重复取消', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'running',
        result: { status: 'cancelling', payment_requests_sent: 0 },
        createdAt: '',
        updatedAt: ''
      }
    ];
    await nextTick();
    expect(flow.canCancel.value).toBe(false);
    expect(flow.formLocked.value).toBe(true);
    expect(flow.workflowMessage.value).toContain('清理本次窗口');
    await flow.cancel();
    expect(mock.connectorCancel).not.toHaveBeenCalled();
  });
  it('未收到本机取消确认时不把服务端任务伪装成已结束', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'running',
        result: { stage: 'session_restore', payment_requests_sent: 0 },
        createdAt: '',
        updatedAt: ''
      }
    ];
    await nextTick();
    mock.connectorCancel.mockRejectedValueOnce(new Error('连接器暂时无响应'));
    await flow.cancel();
    expect(mock.cancelBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('连接器暂时无响应');
    await flow.cancel();
    expect(mock.cancelBitBrowser).toHaveBeenCalledWith(launch.id);
  });
  it('本机连接器未收到任务时停止操作自动清理服务端等待记录', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'pro-20x',
        action: 'bitbrowser',
        state: 'unknown',
        result: {
          status: 'waiting_local_connector',
          stage: 'connector_dispatch',
          resolution_only: true,
          payment_attempted: false,
          payment_requests_sent: 0
        },
        createdAt: '',
        updatedAt: ''
      }
    ];
    flow.selectJob(launch.id);
    await nextTick();
    expect(flow.canCancel.value).toBe(true);
    mock.connectorCancel.mockRejectedValueOnce(new RechargeConnectorError('missing'));

    await flow.cancel();

    expect(mock.abandonUnreceivedBitBrowser).toHaveBeenCalledWith(launch.id);
    expect(mock.cancelBitBrowser).not.toHaveBeenCalled();
  });
  it('粘贴 JSON 后自动载入注册邮箱，默认 Plus 且不启动任务', () => {
    flow.updateJsonInput(sessionJson());
    expect(flow.plan.value).toBe('plus');
    expect(flow.lockedCurrency.value).toBe('PHP');
    expect(flow.sessionJson.value).toBe(sessionJson());
    expect(flow.jsonInput.value).toBe('');
    expect(flow.details.value.email).toBe('registered@example.com');
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });

  it('只有补齐资料并授权单次付款后才可一键执行', async () => {
    fillForm();
    expect(flow.canStart.value).toBe(true);
    await flow.start();

    const serverInput = mock.startBitBrowser.mock.calls[0]![0];
    expect(serverInput).toMatchObject({
      plan: 'plus',
      addressId: address.id,
      windowName: '申请gpt-001',
      lockedCurrency: 'PHP',
      maxAmount: '30.00',
      expectedEmail: 'registered@example.com',
      authorizeSinglePayment: true
    });
    expect(JSON.stringify(serverInput)).not.toContain('5555555555554444');
    expect(JSON.stringify(serverInput)).not.toContain(sessionJson());

    const connectorInput = mock.connectorStart.mock.calls[0]![2];
    expect(connectorInput).toMatchObject({
      sessionJson: sessionJson(),
      details: {
        number: '5555555555554444',
        expiry: '12/30',
        cvc: '123',
        name: 'Test User',
        email: 'registered@example.com'
      },
      address: launch.address,
      safety: launch.safety,
      authorizeSinglePayment: true
    });
    expect(flow.details.value.number).toBe('5555555555554444');
  });

  it('切换为仅登录窗口模式后，只需授权 JSON 即可打开比特浏览器且不提交付款资料', async () => {
    flow.operationMode.value = 'open_browser';
    expect(flow.canStartOpen.value).toBe(false);

    flow.updateJsonInput(sessionJson('user123@example.com'));
    expect(flow.sessionJson.value).toBeTruthy();
    expect(flow.windowName.value).toBe('ChatGPT-user123');
    expect(flow.canStartOpen.value).toBe(true);
    expect(flow.canStart.value).toBe(false);
    expect(flow.workflowMessage.value).toBe('核对窗口名称后，点击即可打开比特浏览器并自动登录。');

    await flow.startOpen();

    expect(mock.startBitBrowserOpen).toHaveBeenCalledTimes(1);
    const serverInput = mock.startBitBrowserOpen.mock.calls[0]![0];
    expect(serverInput).toMatchObject({
      windowName: 'ChatGPT-user123'
    });
    expect(serverInput).not.toHaveProperty('plan');
    expect(serverInput).not.toHaveProperty('addressId');
    expect(serverInput).not.toHaveProperty('maxAmount');

    expect(mock.connectorStart).toHaveBeenCalledTimes(1);
    const connectorInput = mock.connectorStart.mock.calls[0]![2];
    expect(connectorInput).toMatchObject({
      mode: 'open_browser',
      windowName: 'ChatGPT-user123',
      sessionJson: sessionJson('user123@example.com')
    });
    expect(connectorInput).not.toHaveProperty('details');
    expect(connectorInput).not.toHaveProperty('address');
    expect(connectorInput).not.toHaveProperty('safety');
    expect(connectorInput).not.toHaveProperty('authorizeSinglePayment');
  });

  it('仅登录窗口模式执行完成后 workflowMessage 提示窗口已就绪可手动操作', () => {
    jobs.value.items = [
      {
        id: '99999999-9999-4999-8999-999999999999',
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        result: {
          mode: 'open_browser',
          status: 'session_ready',
          stage: 'session_ready',
          window_name: 'ChatGPT-user123'
        },
        createdAt: '2026-03-16T12:00:00Z',
        updatedAt: '2026-03-16T12:00:00Z'
      }
    ];
    flow.selectJob('99999999-9999-4999-8999-999999999999');
    expect(flow.workflowMessage.value).toBe('账号登录成功，比特浏览器窗口已打开，可进行手动操作。');
  });

  it('核价失败和付款结果未确认时保留卡资料', async () => {
    fillForm();
    await flow.start();
    const startedId = mock.startBitBrowser.mock.calls[0]![0].id;
    jobs.value.items = [
      {
        id: startedId,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'running',
        result: { status: 'blocked', reason: 'payment_quote_incomplete', payment_requests_sent: 0 },
        createdAt: '',
        updatedAt: ''
      }
    ];
    await nextTick();
    expect(flow.details.value.number).toBe('5555555555554444');

    jobs.value.items[0]!.result = {
      status: 'blocked',
      payment_attempted: true,
      payment_requests_sent: 1
    };
    addresses.value.items = [];
    await nextTick();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.details.value.expiry).toBe('12/30');
    expect(flow.details.value.cvc).toBe('123');
    expect(flow.selectedAddressId.value).toBe('');
  });

  it('连接预检失败时保留资料并显示原因，不建记录也不发送充值', async () => {
    fillForm();
    mock.connectorCatalog.mockRejectedValueOnce(new Error('本机连接密钥不匹配'));
    await flow.start();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('本机连接密钥不匹配');
    expect(flow.connectorMessage.value).toBe('本机连接密钥不匹配');
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.sessionJson.value).toBe(sessionJson());
  });

  it('比特分组或标签不唯一时不创建任务，检测后重试只创建一次', async () => {
    fillForm();
    mock.connectorCatalog.mockResolvedValueOnce({ groups: [], tags: [] });
    await flow.start();
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toContain('窗口分组不存在或重名');
    await flow.start();
    expect(mock.startBitBrowser).toHaveBeenCalledOnce();
    expect(mock.connectorStart).toHaveBeenCalledOnce();
  });

  it('离开页面时中止未完成预检，不在后台创建任务', async () => {
    fillForm();
    let finish!: (value: unknown) => void;
    mock.connectorCatalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = flow.start();
    await vi.waitFor(() => expect(mock.connectorCatalog).toHaveBeenCalledOnce());
    scope.stop();
    finish({
      groups: [{ id: 'g', name: settings.groupName }],
      tags: [{ id: 't', name: settings.tagName }]
    });
    await pending;
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });

  it('本机回执丢失时先查接收状态，确认未接收才结束任务', async () => {
    fillForm();
    mock.connectorStart.mockRejectedValueOnce(new Error('连接超时'));
    mock.connectorStatus.mockRejectedValueOnce(new Error('未找到任务'));

    await flow.start();
    const startedId = mock.startBitBrowser.mock.calls[0]![0].id;

    expect(mock.connectorStatus).toHaveBeenCalledWith(
      settings.connectorUrl,
      launch.connectorToken,
      startedId
    );
    expect(mock.abandonUnreceivedBitBrowser).toHaveBeenCalledWith(startedId);
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.error.value).toContain('已安全结束');
  });

  it('回执丢失但本机已接收时不重发也不结束任务', async () => {
    fillForm();
    mock.connectorStart.mockRejectedValueOnce(new Error('响应丢失'));

    await flow.start();

    expect(mock.connectorStatus).toHaveBeenCalledOnce();
    expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
    expect(mock.connectorStart).toHaveBeenCalledOnce();
    expect(flow.error.value).toBe('');
  });

  it('本人验证只恢复原本机任务，不新建付款', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'awaiting_human_verification',
        result: { stage: 'verification_required', payment_requests_sent: 0 },
        createdAt: '',
        updatedAt: ''
      }
    ];
    await nextTick();
    await flow.resume();
    expect(mock.bitBrowserAccess).toHaveBeenCalledWith(launch.id);
    expect(mock.connectorResume).toHaveBeenCalledWith(
      settings.connectorUrl,
      launch.connectorToken,
      launch.id
    );
    expect(mock.startBitBrowser).not.toHaveBeenCalled();
  });

  it('付款结果未知时只读复查原单，不发送卡资料或付款授权', async () => {
    const source: V2RechargeJob = {
      id: launch.id,
      plan: 'plus',
      action: 'bitbrowser',
      state: 'unknown',
      result: { payment_attempted: true, payment_status: 'unknown', payment_requests_sent: 1 },
      createdAt: '',
      updatedAt: ''
    };
    jobs.value.items = [source];
    flow.selectJob(source.id);
    flow.updateJsonInput(sessionJson());
    flow.windowName.value = '原单复查-001';
    await nextTick();
    expect(flow.canRecheck.value).toBe(true);

    await flow.recheck();

    expect(mock.recheckBitBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ sourceJobId: source.id, plan: 'plus', windowName: '原单复查-001' })
    );
    const body = mock.connectorStart.mock.calls[0]![2];
    expect(body).toMatchObject({ mode: 'recheck', plan: 'plus', sessionJson: sessionJson() });
    expect(body.details).toBeUndefined();
    expect(body.address).toBeUndefined();
    expect(body.safety).toBeUndefined();
    expect(body.authorizeSinglePayment).toBeUndefined();
  });

  it('确认银行卡未收到请求时只发送历史状态处理任务', async () => {
    mock.resolveNoBankRequest.mockResolvedValue({ ...resolutionLaunch, alreadyResolved: false });
    const source: V2RechargeJob = {
      id: resolutionLaunch.sourceJobId,
      plan: 'pro-20x',
      action: 'bitbrowser',
      state: 'finished',
      result: {
        status: 'payment_result_unknown',
        payment_attempted: true,
        confirmation_requests_sent: 0,
        payment_requests_sent: 1,
        payment_status: 'unknown',
        checkout_identifier: 'oaics_historical',
        resolution_verification_job_id: resolutionLaunch.verificationJobId
      },
      createdAt: '2026-09-09T00:00:00Z',
      updatedAt: '2026-09-09T00:00:00Z'
    };
    jobs.value.items = [source];
    flow.selectJob(source.id);
    await nextTick();
    expect(flow.canResolveNoBankRequest.value).toBe(true);

    await flow.resolveNoBankRequest();

    expect(mock.confirmResolution).toHaveBeenCalledOnce();
    expect(mock.resolveNoBankRequest).toHaveBeenCalledWith(source.id, {
      confirmNoBankRequest: true,
      verificationJobId: resolutionLaunch.verificationJobId
    });
    const body = mock.connectorStart.mock.calls[0]![2];
    expect(body).toMatchObject({
      mode: 'resolve_unknown_payment',
      plan: 'pro-20x',
      sourceJobId: source.id,
      verificationJobId: resolutionLaunch.verificationJobId
    });
    expect(body.sessionJson).toBeUndefined();
    expect(body.bitBrowser).toBeUndefined();
    expect(body.details).toBeUndefined();
    expect(body.authorizeSinglePayment).toBeUndefined();
  });

  it('已明确开通成功的记录不再显示原单复查', async () => {
    jobs.value.items = [
      {
        id: launch.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        result: {
          status: 'subscription_activated',
          payment_status: 'paid',
          payment_attempted: true,
          payment_requests_sent: 1
        },
        createdAt: '',
        updatedAt: ''
      }
    ];
    flow.selectJob(launch.id);
    flow.updateJsonInput(sessionJson());
    flow.windowName.value = '已成功任务';
    await nextTick();

    expect(flow.canRecheck.value).toBe(false);
  });

  it('只轮询会由本机执行器继续更新的状态', () => {
    const resolver = mock.jobOptions?.getRevalidateAt;
    const running = {
      id: launch.id,
      plan: 'plus',
      action: 'bitbrowser',
      state: 'running',
      result: {},
      createdAt: '',
      updatedAt: ''
    } as V2RechargeJob;
    expect(resolver?.({ configured: true, items: [] })).toBeNull();
    expect(resolver?.({ configured: true, items: [running] })).toBeTypeOf('number');
    expect(
      resolver?.({
        configured: true,
        items: [{ ...running, state: 'awaiting_human_verification' }]
      })
    ).toBeTypeOf('number');
    expect(resolver?.({ configured: true, items: [{ ...running, state: 'finished' }] })).toBeNull();
  });

  it('已保存密钥可留空，更新时不回传旧密钥', async () => {
    flow.settingsForm.value.groupName = '新分组';
    await flow.saveSettings();
    expect(mock.updateBitBrowserSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        groupName: '新分组',
        localApiToken: undefined,
        connectorToken: undefined,
        dynamicProxyUrl: undefined
      })
    );
  });

  it('固定代理无需动态链接，保存窗口选项和凭据后清除输入', async () => {
    const browserOptions = {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      proxyMode: 'static' as const,
      staticHost: 'proxy.example',
      staticPort: 1080,
      os: 'Win32' as const,
      syncCookies: false
    };
    storedSettings.value = { ...settings, dynamicProxyUrlConfigured: false, browserOptions };
    await nextTick();
    fillForm();
    expect(flow.canStart.value).toBe(true);
    flow.setSettingsOpen(true);
    flow.settingsForm.value.staticProxyUsername = 'fixture-user';
    flow.settingsForm.value.staticProxyPassword = 'fixture-password';
    mock.updateBitBrowserSettings.mockResolvedValueOnce({
      ...storedSettings.value,
      staticProxyCredentialsConfigured: true
    });
    await flow.saveSettings();
    expect(mock.updateBitBrowserSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        browserOptions,
        dynamicProxyUrl: undefined,
        staticProxyCredentials: { username: 'fixture-user', password: 'fixture-password' }
      })
    );
    expect(mock.updateBitBrowserSettings.mock.calls[0]![0]).not.toHaveProperty(
      'staticProxyPassword'
    );
    expect(flow.settingsForm.value.staticProxyPassword).toBe('');
    expect(flow.settingsForm.value.browserOptions).toEqual(browserOptions);
  });

  it('设置刷新及关闭重开均保留未保存的代理链接', async () => {
    flow.setSettingsOpen(true);
    flow.settingsForm.value.dynamicProxyUrl = 'https://new-proxy.example/extract';
    storedSettings.value = { ...settings, groupName: '后台更新的分组' };
    await nextTick();
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('https://new-proxy.example/extract');
    expect(flow.settingsDirty.value).toBe(true);
    flow.setSettingsOpen(false);
    flow.setSettingsOpen(true);
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('https://new-proxy.example/extract');
    expect(flow.settingsForm.value.groupName).toBe(settings.groupName);
    expect(flow.settingsDirty.value).toBe(true);
  });

  it('设置保存失败留在抽屉并保留输入，重试成功后清除秘密输入', async () => {
    flow.setSettingsOpen(true);
    flow.settingsForm.value.dynamicProxyUrl = 'https://new-proxy.example/extract';
    mock.updateBitBrowserSettings.mockRejectedValueOnce(new Error('设置保存失败'));
    await flow.saveSettings();
    expect(flow.settingsOpen.value).toBe(true);
    expect(flow.settingsError.value).toBe('设置保存失败');
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('https://new-proxy.example/extract');
    expect(flow.settingsDirty.value).toBe(true);
    await flow.saveSettings();
    expect(flow.settingsOpen.value).toBe(false);
    expect(flow.settingsError.value).toBe('');
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('');
    expect(flow.settingsDirty.value).toBe(false);
  });

  it('设置保存进行中不重复提交且不能关闭抽屉', async () => {
    flow.setSettingsOpen(true);
    let resolveSave!: (value: V2RechargeBitBrowserSettings) => void;
    mock.updateBitBrowserSettings.mockImplementationOnce(
      () =>
        new Promise<V2RechargeBitBrowserSettings>((resolve) => {
          resolveSave = resolve;
        })
    );
    const saving = flow.saveSettings();
    await flow.saveSettings();
    flow.setSettingsOpen(false);
    expect(mock.updateBitBrowserSettings).toHaveBeenCalledTimes(1);
    expect(flow.settingsOpen.value).toBe(true);
    resolveSave(settings);
    await saving;
    expect(flow.settingsSaving.value).toBe(false);
  });

  it('离页后恢复资料草稿，安全码、临时验证码和单次付款授权需重新输入', () => {
    fillForm();
    flow.loginCode.value = '123456';
    flow.loginPassword.value = 'fixture-password';
    flow.settingsForm.value.dynamicProxyUrl = 'https://proxy.example/draft';
    scope.stop();
    mock.queryIndex = 0;
    scope = effectScope();
    flow = scope.run(useAutoRecharge)!;
    expect(flow.sessionJson.value).toBe(sessionJson());
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.details.value.name).toBe('Test User');
    expect(flow.details.value.cvc).toBe('');
    expect(flow.loginPassword.value).toBe('fixture-password');
    expect(flow.loginCode.value).toBe('');
    expect(flow.authorizeSinglePayment.value).toBe(false);
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('https://proxy.example/draft');
    expect(mock.startServer).not.toHaveBeenCalled();
    expect(mock.connectorStart).not.toHaveBeenCalled();
  });
});

describe('服务器自动充值', () => {
  async function serverPasswordForm() {
    flow.operationMode.value = 'server_payment';
    fillForm();
    const proxyId = '33333333-3333-4333-8333-333333333333';
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['US'] };
    (mock.proxiesQuery.data as { value: unknown }).value = {
      items: [{ id: proxyId, countryCode: 'US', status: 'active', kind: 'dynamic_residential' }]
    };
    flow.selectedProxyCountryCode.value = 'US';
    flow.loginMethod.value = 'password';
    flow.loginEmail.value = 'registered@example.com';
    flow.loginPassword.value = 'synthetic-password';
    flow.totp.source.value = 'saved';
    await nextTick();
    flow.selectedProxyId.value = proxyId;
  }

  async function startServerFixture() {
    await serverPasswordForm();
    flow.totp.source.value = 'secret';
    flow.totp.secretInput.value = 'JBSWY3DPEHPK3PXP';
    await flow.start();
    const job: V2RechargeJob = {
      id: mock.startServer.mock.calls[0]![0].id,
      plan: 'plus',
      action: 'server',
      state: 'running',
      result: { status: 'running', payment_attempted: false, payment_requests_sent: 0 },
      createdAt: '',
      updatedAt: ''
    };
    jobs.value.items = [job];
    await nextTick();
    return jobs.value.items[0]!;
  }

  it('代理核验失败后保留全部输入，直接点击可创建新的任务', async () => {
    const job = await startServerFixture();
    expect(flow.canStart.value).toBe(false);
    job.state = 'finished';
    job.result = {
      status: 'blocked',
      reason: 'proxy_network_unconfirmed',
      payment_attempted: false,
      payment_requests_sent: 0
    };
    await nextTick();
    expect(flow.sessionJson.value).toBe(sessionJson());
    expect(flow.loginPassword.value).toBe('synthetic-password');
    expect(flow.totp.secretInput.value).toBe('JBSWY3DPEHPK3PXP');
    expect(flow.details.value).toMatchObject({
      number: '5555555555554444',
      expiry: '12/30',
      cvc: '123',
      name: 'Test User',
      email: 'registered@example.com',
      country: 'US',
      line1: address.line1
    });
    expect(flow.authorizeSinglePayment.value).toBe(true);
    expect(flow.workflowMessage.value).toContain('可再次执行');
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startServer).toHaveBeenCalledTimes(2);
    expect(mock.startServer.mock.calls[1]![0].id).not.toBe(job.id);
  });

  it.each(['unknown', 'finished'] as const)(
    '付款结果不明且状态为 %s 时保留输入并禁止再次付款',
    async (state) => {
      const job = await startServerFixture();
      job.state = state;
      job.result = {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true,
        payment_requests_sent: 1
      };
      await nextTick();
      expect(flow.canStart.value).toBe(false);
      expect(flow.canRecheck.value).toBe(true);
      expect(flow.details.value.cvc).toBe('123');
      expect(flow.loginPassword.value).toBe('synthetic-password');
      await flow.start();
      expect(mock.startServer).toHaveBeenCalledTimes(1);
    }
  );

  it('官网明确拒付后保留输入，允许再次执行', async () => {
    const job = await startServerFixture();
    job.state = 'finished';
    job.result = {
      status: 'payment_failed',
      payment_status: 'declined',
      payment_attempted: true,
      payment_requests_sent: 1
    };
    await nextTick();
    expect(flow.canStart.value).toBe(true);
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.totp.secretInput.value).toBe('JBSWY3DPEHPK3PXP');
  });

  it('已付款待开通仍保留输入，确认充值成功后才清空', async () => {
    const job = await startServerFixture();
    job.state = 'finished';
    job.result = {
      status: 'paid_pending_activation',
      payment_status: 'paid',
      payment_attempted: true,
      payment_requests_sent: 1
    };
    await nextTick();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.canStart.value).toBe(false);
    job.result.status = 'subscription_activated';
    await nextTick();
    expect(flow.sessionJson.value).toBe('');
    expect(flow.loginEmail.value).toBe('');
    expect(flow.loginPassword.value).toBe('');
    expect(flow.totp.secretInput.value).toBe('');
    expect(flow.details.value).toMatchObject({
      number: '',
      expiry: '',
      cvc: '',
      name: '',
      email: ''
    });
    expect(flow.authorizeSinglePayment.value).toBe(false);
    expect(flow.workflowMessage.value).toBe('充值成功，订阅已开通。');
    fillForm();
    flow.loginMethod.value = 'json';
    await nextTick();
    expect(flow.canStart.value).toBe(true);
  });

  it('前一笔成功结果迟到时，不清空用户已修正的输入', async () => {
    const job = await startServerFixture();
    job.state = 'finished';
    job.result = { status: 'blocked', payment_requests_sent: 0 };
    await nextTick();
    flow.details.value.name = 'Later Edit';
    job.result = { status: 'subscription_activated', payment_status: 'paid' };
    await nextTick();
    expect(flow.details.value.name).toBe('Later Edit');
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.loginPassword.value).toBe('synthetic-password');
  });

  it('离页返回后恢复失败任务的资料，重新输入安全码并授权即可重试', async () => {
    const job = await startServerFixture();
    scope.stop();
    job.state = 'finished';
    job.result = {
      status: 'blocked',
      reason: 'proxy_network_unconfirmed',
      payment_requests_sent: 0
    };
    mock.queryIndex = 0;
    scope = effectScope();
    flow = scope.run(useAutoRecharge)!;
    await nextTick();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.loginPassword.value).toBe('synthetic-password');
    expect(flow.totp.secretInput.value).toBe('JBSWY3DPEHPK3PXP');
    expect(flow.details.value.cvc).toBe('');
    expect(flow.authorizeSinglePayment.value).toBe(false);
    flow.details.value.cvc = '123';
    flow.authorizeSinglePayment.value = true;
    expect(flow.canStart.value).toBe(true);
  });

  it('停止未付款的服务器任务也保留输入', async () => {
    await startServerFixture();
    expect(flow.canCancel.value).toBe(true);
    await flow.cancel();
    expect(mock.cancelServer).toHaveBeenCalledOnce();
    expect(flow.details.value.cvc).toBe('123');
    expect(flow.loginPassword.value).toBe('synthetic-password');
  });

  it('启动接口失败且确认没有创建记录时，不继续轮询不存在的任务', async () => {
    await serverPasswordForm();
    flow.totp.source.value = 'secret';
    flow.totp.secretInput.value = 'JBSWY3DPEHPK3PXP';
    mock.startServer.mockRejectedValueOnce(new Error('服务器暂时不可用'));
    await flow.start();
    expect(flow.error.value).toBe('服务器暂时不可用');
    expect(mock.jobOptions!.getRevalidateAt!(jobs.value)).toBeNull();
    expect(flow.canStart.value).toBe(true);
  });

  it('只有开通状态但尚未确认已付款时，不清空资料', async () => {
    const job = await startServerFixture();
    job.state = 'finished';
    job.result = { status: 'subscription_activated' };
    await nextTick();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.loginPassword.value).toBe('synthetic-password');
  });

  it('成功结果迟到时，不清空之后修改的安全码', async () => {
    const job = await startServerFixture();
    job.state = 'finished';
    job.result = { status: 'blocked', payment_requests_sent: 0 };
    await nextTick();
    flow.details.value.cvc = '456';
    job.result = { status: 'subscription_activated', payment_status: 'paid' };
    await nextTick();
    expect(flow.details.value.cvc).toBe('456');
    expect(flow.details.value.number).toBe('5555555555554444');
  });

  it.each([
    ['PH', 'library'],
    ['PH', 'manual'],
    ['JP', 'library'],
    ['GB', 'library']
  ] as const)('代理国家 %s 可搭配美国 %s 账单地址启动', async (countryCode, addressSource) => {
    await serverPasswordForm();
    const proxyId = '33333333-3333-4333-8333-333333333333';
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: [countryCode] };
    (mock.proxiesQuery.data as { value: unknown }).value = {
      items: [{ id: proxyId, countryCode, status: 'active', kind: 'dynamic_residential' }]
    };
    flow.selectedProxyCountryCode.value = countryCode;
    flow.addressSource.value = addressSource;
    flow.totp.source.value = 'secret';
    flow.totp.secretInput.value = 'JBSWY3DPEHPK3PXP';
    await nextTick();
    flow.selectedProxyId.value = proxyId;
    expect(flow.details.value.country).toBe('US');
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyCountryCode: countryCode,
        lockedCurrency: 'PHP',
        details: expect.objectContaining({ country: 'US' })
      })
    );
  });

  it('服务器模式可选择系统 2FA，只提交账号编号，不在浏览器取当次验证码', async () => {
    await serverPasswordForm();
    expect(flow.canStart.value).toBe(false);
    flow.totp.savedAccountId.value = savedTotp.value.items[0]!.id;
    flow.totp.secretInput.value = 'JBSWY3DPEHPK3PXP';
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    const submitted = mock.startServer.mock.calls[0]![0];
    expect(submitted.login).toEqual({
      email: 'registered@example.com',
      password: 'synthetic-password',
      totpAccountId: savedTotp.value.items[0]!.id
    });
    expect(submitted.login).not.toHaveProperty('totpSecret');
    expect(submitted.login).not.toHaveProperty('token');
    expect(mock.listTotpAccounts).not.toHaveBeenCalled();
    expect(mock.connectorSubmitCode).not.toHaveBeenCalled();
    expect(flow.loginPassword.value).toBe('synthetic-password');
    expect(flow.totp.savedAccountId.value).toBe(savedTotp.value.items[0]!.id);
  });

  it('服务器只读复查同样提交系统 2FA 编号，不提交银行卡或新付款授权', async () => {
    const sourceId = '99999999-9999-4999-8999-999999999999';
    jobs.value.items = [
      {
        id: sourceId,
        plan: 'plus',
        action: 'server',
        state: 'unknown',
        createdAt: '',
        updatedAt: '',
        result: { payment_attempted: true, payment_requests_sent: 1, payment_status: 'unknown' }
      }
    ];
    flow.selectJob(sourceId);
    await serverPasswordForm();
    flow.totp.savedAccountId.value = savedTotp.value.items[0]!.id;
    expect(flow.canRecheck.value).toBe(true);
    await flow.recheck();
    const submitted = mock.recheckServer.mock.calls[0]![0];
    expect(submitted.login).toEqual({
      email: 'registered@example.com',
      password: 'synthetic-password',
      totpAccountId: savedTotp.value.items[0]!.id
    });
    expect(submitted).not.toHaveProperty('details');
    expect(submitted).not.toHaveProperty('authorizeSinglePayment');
  });

  it('服务器启动失败保留 2FA 选择和输入，允许修正后重试', async () => {
    await serverPasswordForm();
    flow.totp.savedAccountId.value = savedTotp.value.items[0]!.id;
    mock.startServer.mockRejectedValueOnce(new Error('系统 2FA 账号已删除，请重新选择'));
    await flow.start();
    expect(flow.error.value).toContain('重新选择');
    expect(flow.loginPassword.value).toBe('synthetic-password');
    expect(flow.totp.source.value).toBe('saved');
    expect(flow.totp.savedAccountId.value).toBe(savedTotp.value.items[0]!.id);
  });

  it('2FA 列表读取失败不清理选择，成功确认账号已不存在时才清除', async () => {
    await serverPasswordForm();
    const accountId = savedTotp.value.items[0]!.id;
    flow.totp.savedAccountId.value = accountId;
    phase.value = 'refreshing';
    savedTotp.value.items = [];
    expect(flow.totp.savedAccountId.value).toBe(accountId);
    (mock.totpQuery.error as { value: string | null }).value = '读取失败';
    phase.value = 'ready';
    expect(flow.totp.savedAccountId.value).toBe(accountId);
    (mock.totpQuery.error as { value: string | null }).value = null;
    expect(flow.totp.savedAccountId.value).toBe('');
    expect(flow.canStart.value).toBe(false);
  });

  it('其他验证方式不附带系统 2FA 或密钥', async () => {
    await serverPasswordForm();
    flow.totp.source.value = 'manual';
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startServer.mock.calls[0]![0].login).toEqual({
      email: 'registered@example.com',
      password: 'synthetic-password'
    });
  });

  it('切换验证方式及模式时，查询临时清空数据不清理已保存的 2FA 选择', async () => {
    await serverPasswordForm();
    const previousData = savedTotp.value;
    const accountId = previousData.items[0]!.id;
    flow.totp.savedAccountId.value = accountId;
    flow.totp.source.value = 'manual';
    (mock.totpQuery.data as { value: unknown }).value = undefined;
    flow.totp.source.value = 'saved';
    expect(flow.totp.savedAccountId.value).toBe(accountId);
    (mock.totpQuery.data as { value: unknown }).value = previousData;
    flow.operationMode.value = 'payment';
    expect(flow.totp.savedAccountId.value).toBe(accountId);
    expect(flow.totp.ready.value).toBe(true);
  });

  it('已保存账号首次登录国家与当前代理国家不符时禁止启动', async () => {
    flow.operationMode.value = 'server_payment';
    fillForm();
    mock.accountIdentity.mockResolvedValue({ email: 'registered@example.com' });
    (mock.bankAccountsQuery.data as { value: unknown }).value = {
      items: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          emailMasked: 're***@example.com',
          status: 'active',
          subscriptionState: 'never_subscribed',
          hasPassword: true,
          hasTotp: false,
          firstLoginNetwork: { ip: '8.8.8.8', countryCode: 'US', observedAt: '' }
        }
      ]
    };
    flow.loginMethod.value = 'saved';
    flow.selectedBankAccountId.value = '44444444-4444-4444-8444-444444444444';
    flow.selectedProxyCountryCode.value = 'PH';
    await nextTick();
    expect(flow.loginCountryRestriction.value).toBe('US');
    expect(flow.canStart.value).toBe(false);
    flow.selectedProxyCountryCode.value = 'US';
    expect(flow.loginCountryRestriction.value).toBe('');
  });

  it('服务器接收任务后保留授权和卡资料，等待官网成功结果', async () => {
    flow.operationMode.value = 'server_payment';
    fillForm();
    const proxyId = '33333333-3333-4333-8333-333333333333';
    (mock.proxyCountriesQuery.data as { value: unknown }).value = { items: ['US'] };
    (mock.proxiesQuery.data as { value: unknown }).value = {
      items: [{ id: proxyId, countryCode: 'US', status: 'active', kind: 'dynamic_residential' }]
    };
    flow.selectedProxyCountryCode.value = 'US';
    await nextTick();
    flow.selectedProxyId.value = proxyId;
    expect(flow.canStart.value).toBe(true);
    await flow.start();
    expect(mock.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'server',
        plan: 'plus',
        addressId: address.id,
        authorizeSinglePayment: true,
        sessionJson: sessionJson(),
        proxyId,
        proxyCountryCode: 'US'
      })
    );
    expect(mock.startServer.mock.calls[0]![0]).not.toHaveProperty('maxAmount');
    expect(mock.connectorStart).not.toHaveBeenCalled();
    expect(flow.sessionJson.value).toBe(sessionJson());
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.details.value.cvc).toBe('123');
    expect(flow.canStart.value).toBe(false);
    await flow.start();
    expect(mock.startServer).toHaveBeenCalledTimes(1);
  });

  it('结果不明时只向服务器提交原任务授权，不传卡资料或付款上限', async () => {
    const sourceId = '99999999-9999-4999-8999-999999999999';
    jobs.value.items = [
      {
        id: sourceId,
        plan: 'plus',
        action: 'server',
        state: 'unknown',
        createdAt: '',
        updatedAt: '',
        result: {
          payment_attempted: true,
          payment_requests_sent: 1,
          payment_status: 'unknown'
        }
      }
    ];
    flow.selectJob(sourceId);
    flow.updateJsonInput(sessionJson());
    expect(flow.canRecheck.value).toBe(true);
    await flow.recheck();
    expect(mock.recheckServer).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJobId: sourceId,
        sessionJson: sessionJson()
      })
    );
    const input = mock.recheckServer.mock.calls[0]![0];
    expect(input).not.toHaveProperty('details');
    expect(input).not.toHaveProperty('maxAmount');
    expect(mock.recheckBitBrowser).not.toHaveBeenCalled();
    expect(flow.sessionJson.value).toBe(sessionJson());
  });
});
