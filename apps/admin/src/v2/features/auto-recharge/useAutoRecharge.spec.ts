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
import { RechargeConnectorError } from './connector-transport';
import { useAutoRecharge } from './useAutoRecharge';
import { clearV2SessionDrafts, useV2FormDraft } from '@/v2/composables/useV2SessionDraft';

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
  preparePaymentCard: vi.fn(),
  managedCardDetail: vi.fn(),
  accountIdentity: vi.fn(),
  loginCredential: vi.fn(),
  accountTotpCode: vi.fn(),
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
  directSubmitCode: vi.fn(),
  directCancel: vi.fn(),
  callbackUrl: vi.fn((id: string) => `https://admin.example/api/local/${id}`),
  confirmResolution: vi.fn()
}));

vi.mock('./bitbrowser-direct-api', async (original) => ({
  ...(await original<typeof import('./bitbrowser-direct-api')>()),
  directBrowserCatalog: mock.directCatalog
}));
vi.mock('./useBitBrowserDirectOpen', () => ({
  useBitBrowserDirectOpen: () => ({
    start: mock.directStart,
    owns: mock.directOwns,
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
    getBitBrowserSettings: vi.fn(),
    getServerProxySettings: vi.fn(),
    updateServerProxySettings: mock.updateServerProxySettings,
    startBitBrowser: mock.startBitBrowser,
    startServer: mock.startServer,
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
    matchCardName: mock.matchCardName,
    preparePaymentCard: mock.preparePaymentCard,
    listCards: vi.fn(),
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
  bankAccounts.value = { items: [] };
  mock.accountIdentity.mockResolvedValue({ email: 'registered@example.com' });
  mock.loginCredential.mockResolvedValue({
    email: 'registered@example.com',
    password: 'synthetic-password'
  });
  mock.accountTotpCode.mockResolvedValue({ token: '123456' });
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
  mock.paymentCardsQuery = queryResult(ref({ items: [] }));
  mock.proxyCountriesQuery = queryResult(ref({ items: [] }));
  mock.proxiesQuery = {
    ...queryResult(ref({ items: [], total: 0 })),
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
  mock.directCatalog.mockResolvedValue({
    groups: [{ id: 'group-direct', name: settings.groupName }],
    tags: [{ id: 'tag-direct', name: settings.tagName }]
  });
  mock.directStart.mockResolvedValue(undefined);
  mock.directRunning = ref(false);
  mock.directOwns.mockReturnValue(false);
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

afterEach(() => scope.stop());

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

async function choosePasswordAccount(hasPassword = true, hasTotp = false) {
  bankAccounts.value.items = [account(hasPassword, hasTotp)];
  flow.loginMethod.value = 'password';
  flow.selectedBankAccountId.value = 'account-fixture';
  await nextTick();
  await nextTick();
}

describe('比特浏览器充值入口', () => {
  it('默认仅为比特充值，载入 JSON 自动识别邮箱、窗名与可复用地址', () => {
    expect(flow.operationMode.value).toBe('payment');
    flow.updateJsonInput(sessionJson());
    expect(flow.details.value.email).toBe('registered@example.com');
    expect(flow.windowName.value).toBe('ChatGPT-registered');
    expect(flow.selectedAddressId.value).toBe(address.id);
    addresses.value.items = [{ ...address, status: 'used' }];
    expect(flow.selectedAddress.value?.status).toBe('used');
    addresses.value.items = [{ ...address, status: 'disabled' }];
    expect(flow.availableAddresses.value).toEqual([]);
  });
  it('无唯一账号邮箱或非法 JSON 不能启动，错误不回显授权内容', () => {
    fillForm();
    flow.updateJsonInput('{"token":"sensitive-fixture"}');
    expect(flow.canStart.value).toBe(false);
    expect(flow.jsonError.value).not.toContain('sensitive-fixture');
    flow.updateJsonInput('not-json');
    expect(flow.sessionJson.value).toBe('');
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
  it('启动仅调用本机路径；服务器任务只收到资料引用，秘密只交本机', async () => {
    fillForm();
    await flow.start();
    expect(mock.startBitBrowser).toHaveBeenCalledOnce();
    const input = mock.startBitBrowser.mock.calls[0]![0];
    expect(input).toMatchObject({ manualPaymentConfirmation: true, authorizeSinglePayment: true });
    expect(input).not.toHaveProperty('sessionJson');
    expect(input).not.toHaveProperty('details');
    expect(input).not.toHaveProperty('maxAmount');
    expect(input).not.toHaveProperty('maxAmountMinor');
    expect(JSON.stringify(input)).not.toContain('5555555555554444');
    expect(mock.connectorStart.mock.calls[0]![2]).toMatchObject({
      sessionJson: sessionJson(),
      details: { cvc: '123' },
      safety: { manualPaymentConfirmation: true }
    });
    expect(mock.connectorStart.mock.calls[0]![2].safety).toEqual({
      lockedCurrency: 'USD',
      authorizeSinglePayment: true,
      manualPaymentConfirmation: true
    });
    expect(mock.startServer).not.toHaveBeenCalled();
  });
  it('旧启动回执的金额限制字段不再传给本机，币种和人工确认保护保留', async () => {
    mock.startBitBrowser.mockResolvedValue({
      ...launch,
      safety: { ...launch.safety, maxAmount: '0.01', maxAmountMinor: 1 }
    });
    fillForm();
    await flow.start();
    expect(mock.connectorStart.mock.calls[0]![2].safety).toEqual({
      lockedCurrency: 'USD',
      authorizeSinglePayment: true,
      manualPaymentConfirmation: true
    });
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
    expect(mock.connectorStart.mock.calls[0]![2].login).toEqual({
      email: savedLogin.email,
      password: savedLogin.password
    });
    expect(mock.connectorStart.mock.calls[0]![2].login).not.toHaveProperty('totp');
  });
  it('缺少密码账号不能启动，历史 Go 和未知套餐账号仍可先核对官网', async () => {
    fillForm();
    await choosePasswordAccount(false);
    expect(flow.canStart.value).toBe(false);
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
    expect(mock.connectorStart.mock.calls[0]![2].ownedProfile).toEqual(ownedProfile);
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
  it('连接失败且明确未接收时安全结束，付款资料保留', async () => {
    fillForm();
    mock.connectorStart.mockRejectedValueOnce(new Error('fixture disconnected'));
    mock.connectorStatus.mockRejectedValueOnce(new RechargeConnectorError('missing'));
    await flow.start();
    expect(mock.abandonUnreceivedBitBrowser).toHaveBeenCalledOnce();
    expect(flow.details.value.number).toBe('5555555555554444');
    expect(flow.error.value).toContain('安全结束');
  });
  it('启动响应丢失且本机已经接收，不重发同一任务', async () => {
    fillForm();
    mock.connectorStart.mockRejectedValueOnce(new Error('fixture lost response'));
    await flow.start();
    expect(mock.connectorStart).toHaveBeenCalledOnce();
    expect(mock.abandonUnreceivedBitBrowser).not.toHaveBeenCalled();
    expect(flow.error.value).toBe('');
  });
  it('未知付款只允许复查原单，不重新充值', () => {
    fillForm();
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
  it('确认暂停状态保持原任务锁定并继续拉取状态', () => {
    jobs.value.items = [job('awaiting_confirmation', { quote_digest: 'fixture-digest' })];
    expect(flow.formLocked.value).toBe(true);
    expect(mock.jobOptions?.getRevalidateAt?.(jobs.value)).toBeGreaterThan(Date.now());
    expect(flow.workflowMessage.value).toContain('核对金额');
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
  it('人工验证码只发向所选原任务，自动 2FA 只提交一次', async () => {
    await choosePasswordAccount(true, true);
    jobs.value.items = [job('awaiting_human_verification', { stage: 'login_code_required' })];
    await vi.waitFor(() => expect(mock.connectorSubmitCode).toHaveBeenCalledOnce());
    expect(mock.connectorSubmitCode.mock.calls[0]![2]).toBe('job-fixture');
    flow.retryAutomaticCode();
    await nextTick();
    expect(mock.connectorSubmitCode).toHaveBeenCalledOnce();
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
