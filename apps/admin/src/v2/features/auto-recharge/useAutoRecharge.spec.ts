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

const mock = vi.hoisted(() => ({
  jobsQuery: {} as Record<string, unknown>,
  addressesQuery: {} as Record<string, unknown>,
  settingsQuery: {} as Record<string, unknown>,
  queryIndex: 0,
  jobOptions: undefined as
    | undefined
    | {
        getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
      },
  startBitBrowser: vi.fn(),
  recheckBitBrowser: vi.fn(),
  resolveNoBankRequest: vi.fn(),
  cancelBitBrowser: vi.fn(),
  abandonUnreceivedBitBrowser: vi.fn(),
  bitBrowserAccess: vi.fn(),
  updateBitBrowserSettings: vi.fn(),
  connectorStart: vi.fn(),
  connectorStatus: vi.fn(),
  connectorResume: vi.fn(),
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
    getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
  }) => {
    if (options.moduleKey === 'auto-recharge-addresses') return mock.addressesQuery;
    const result = mock.queryIndex++ === 0 ? mock.jobsQuery : mock.settingsQuery;
    if (options.getRevalidateAt) mock.jobOptions = options;
    return result;
  }
}));

vi.mock('./api', () => ({
  rechargeCallbackUrl: mock.callbackUrl,
  rechargeApi: {
    list: vi.fn(),
    listAddresses: vi.fn(),
    getBitBrowserSettings: vi.fn(),
    startBitBrowser: mock.startBitBrowser,
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
    cancel: mock.connectorCancel,
    health: mock.connectorHealth
  }
}));

vi.mock('@/api/client', () => ({ getApiErrorMessage: (cause: Error) => cause.message }));
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
  vi.clearAllMocks();
  mock.queryIndex = 0;
  jobs.value = { configured: true, items: [] };
  addresses.value.items = [address];
  storedSettings.value = settings;
  phase.value = 'ready';
  mock.jobsQuery = queryResult(jobs);
  mock.addressesQuery = queryResult(addresses);
  mock.settingsQuery = queryResult(storedSettings);
  mock.startBitBrowser.mockImplementation(async (input) => ({ ...launch, id: input.id }));
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
});

afterEach(() => scope.stop());

describe('本机比特浏览器自动充值', () => {
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
      authorizeSinglePayment: true
    });
    expect(JSON.stringify(serverInput)).not.toContain('5555555555554444');
    expect(JSON.stringify(serverInput)).not.toContain('registered@example.com');

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

  it('核价失败保留卡资料，观察到付款请求后才清除', async () => {
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
    expect(flow.details.value.number).toBe('');
    expect(flow.details.value.expiry).toBe('');
    expect(flow.details.value.cvc).toBe('');
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

  it('设置刷新不覆盖未保存的代理链接，放弃后恢复最新设置', async () => {
    flow.setSettingsOpen(true);
    flow.settingsForm.value.dynamicProxyUrl = 'https://new-proxy.example/extract';
    storedSettings.value = { ...settings, groupName: '后台更新的分组' };
    await nextTick();
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('https://new-proxy.example/extract');
    expect(flow.settingsDirty.value).toBe(true);
    flow.setSettingsOpen(false);
    expect(flow.settingsForm.value.dynamicProxyUrl).toBe('');
    expect(flow.settingsForm.value.groupName).toBe('后台更新的分组');
    expect(flow.settingsDirty.value).toBe(false);
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

  it('离开页面时清除 JSON、卡资料和本机连接凭据', () => {
    fillForm();
    scope.stop();
    expect(flow.sessionJson.value).toBe('');
    expect(Object.values(flow.details.value).every((value) => value === '')).toBe(true);
  });
});
