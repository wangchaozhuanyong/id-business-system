import { effectScope, nextTick, ref, type Ref } from 'vue';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { V2RegistrationJob } from './contracts';
import { useRegistrationPage } from './useRegistrationPage';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
const mock = vi.hoisted(() => ({
  connector: vi.fn(),
  create: vi.fn(),
  launch: vi.fn(),
  connection: vi.fn(),
  code: vi.fn(),
  cancel: vi.fn(),
  resumeCredentials: vi.fn(),
  queries: [] as unknown[],
  index: 0
}));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { warning: vi.fn() } }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: () => mock.queries[mock.index++]
}));
vi.mock('@/api/client', () => ({
  http: { defaults: { baseURL: '/api' } },
  getApiErrorMessage: (cause: Error) => cause.message
}));
vi.mock('../auto-recharge/public-api', () => ({
  connectorRequest: mock.connector,
  RechargeConnectorError: class extends Error {},
  useRechargeBrowserSettings: () => ({ settingsOpen: ref(false) })
}));
vi.mock('./api', () => ({
  registrationApi: {
    create: mock.create,
    launch: mock.launch,
    connection: mock.connection,
    code: mock.code,
    cancel: mock.cancel,
    resumeCredentials: mock.resumeCredentials
  }
}));
const id = '11111111-1111-4111-8111-111111111111';
const baseJob = {
  id,
  emailMasked: 'ow***@example.test',
  displayName: '李华',
  state: 'queued',
  step: 'queued',
  attempt: 1,
  offerStatus: 'unknown',
  registered: false,
  passwordVerified: false,
  mfaVerified: false,
  createdAt: '',
  updatedAt: '',
  reason: null,
  browserProfileId: null,
  accountId: null
} as const;
let scope: ReturnType<typeof effectScope>;
let page: ReturnType<typeof useRegistrationPage>;
let rows: Ref<{ items: V2RegistrationJob[]; total: number; page: number; pageSize: number }>;
let activeRow: Ref<V2RegistrationJob | undefined>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearV2SessionDrafts();
  vi.stubGlobal('window', { location: { origin: 'https://manager.example.test' } });
  rows = ref({ items: [baseJob], total: 1, page: 1, pageSize: 20 });
  activeRow = ref();
  mock.index = 0;
  mock.queries = [
    { data: rows, refresh: vi.fn(), ensureFresh: vi.fn() },
    { data: ref({}), phase: ref('ready'), ensureFresh: vi.fn(), refresh: vi.fn() },
    { data: activeRow, phase: ref('ready'), ensureFresh: vi.fn(), refresh: vi.fn() }
  ];
  mock.connection.mockResolvedValue({
    connectorUrl: 'http://127.0.0.1:55321',
    connectorToken: 'synthetic-only'
  });
  mock.launch.mockResolvedValue({
    id,
    mode: 'registration',
    attempt: 1,
    connectorUrl: 'http://127.0.0.1:55321',
    connectorToken: 'synthetic-only',
    password: 'synthetic-only-staged'
  });
  mock.connector.mockResolvedValue({
    service: 'id-business-v2-auto-recharge-connector',
    capabilities: ['account-registration'],
    busy: false,
    originAllowed: true
  });
  mock.create.mockResolvedValue(baseJob);
  mock.code.mockResolvedValue({ code: null });
  scope = effectScope();
  page = scope.run(() => useRegistrationPage({ moduleKey: 'auto-registration' }))!;
  page.formRef.value = { validate: async () => true } as never;
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearV2SessionDrafts();
});
describe('注册表单和邮件生命周期', () => {
  it('不支持注册的连接器不会创建数据库任务，失败保留输入', async () => {
    page.openStart();
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.connector.mockResolvedValueOnce({ service: 'old' });
    await page.start();
    expect(mock.create).not.toHaveBeenCalled();
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
  });
  it('本机确认接收后才清除提交快照，密码不进入会话草稿', async () => {
    page.openStart();
    Object.assign(page.draft.form, {
      mailboxAliasId: 'mail-1',
      proxyId: id,
      birthDate: '1996-01-01',
      confirmIdentity: true
    });
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.connector.mock.calls[1]?.[2].body.callbackUrl).toBe(
      `https://manager.example.test/api/id-business-v2/auto-registration/local/${id}`
    );
    expect(page.formOpen.value).toBe(false);
    page.openStart();
    expect(page.draft.form.mailboxAliasId).toBe('');
    expect(page.draft.form).not.toHaveProperty('password');
  });
  it('提交失败保留输入及任务编号，不标记成功', async () => {
    page.openStart();
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.connector
      .mockResolvedValueOnce({
        service: 'id-business-v2-auto-recharge-connector',
        capabilities: ['account-registration'],
        busy: false,
        originAllowed: true
      })
      .mockRejectedValueOnce(new Error('本机暂时失联'));
    await page.start();
    expect(page.formOpen.value).toBe(true);
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
    expect(page.filters.activeJobId).toBe(id);
  });
  it('只在等待邮件时读取；连接器暂时失败不会消耗邮件，退出页面停止轮询', async () => {
    page.filters.activeJobId = id;
    rows.value.items = [{ ...baseJob, state: 'awaiting_email', step: 'email_code' }];
    mock.code.mockResolvedValue({
      code: '123456',
      mailId: 'mail-current',
      attempt: 1,
      step: 'email_code'
    });
    mock.connector.mockRejectedValueOnce(new Error('本机失联'));
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.code).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8000);
    expect(mock.code).toHaveBeenCalledTimes(2);
    expect(mock.connector.mock.calls[1]?.[2].body).toMatchObject({
      code: '123456',
      mailId: 'mail-current',
      attempt: 1,
      step: 'email_code'
    });
    scope.stop();
    await vi.advanceTimersByTimeAsync(16000);
    expect(mock.code).toHaveBeenCalledTimes(2);
  });
  it('切页保留注册草稿，临时验证码不保留', () => {
    page.openStart();
    page.draft.form.mailboxAliasId = 'mail-kept';
    page.loginCode.value = '123456';
    scope.stop();
    mock.index = 0;
    scope = effectScope();
    page = scope.run(() => useRegistrationPage({ moduleKey: 'auto-registration' }))!;
    page.openStart();
    expect(page.draft.form.mailboxAliasId).toBe('mail-kept');
    expect(page.loginCode.value).toBe('');
  });
  it('列表翻页后仍读取当前任务，不使用其他任务的旧详情', async () => {
    page.filters.activeJobId = id;
    rows.value.items = [];
    activeRow.value = { ...baseJob, state: 'awaiting_email', step: 'email_code' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.selected.value?.id).toBe(id);
    expect(mock.code).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    page.filters.activeJobId = '22222222-2222-4222-8222-222222222222';
    await nextTick();
    expect(page.selected.value).toBeUndefined();
  });
});
