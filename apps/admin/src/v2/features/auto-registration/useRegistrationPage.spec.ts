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
  resume: vi.fn(),
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
vi.mock('./api', () => ({
  registrationApi: {
    create: mock.create,
    launch: mock.launch,
    connection: mock.connection,
    code: mock.code,
    cancel: mock.cancel,
    resume: mock.resume
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
  mock.launch.mockResolvedValue({ id, attempt: 1, delivery: 'accepted' });
  mock.resume.mockResolvedValue({ id, attempt: 1, delivery: 'accepted' });
  mock.create.mockResolvedValue(baseJob);
  mock.code.mockResolvedValue({ id, attempt: 1, delivery: 'accepted' });
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
  it('条件不变时查询仍刷新列表和当前任务，避免关闭重试操作停留在旧状态', () => {
    page.filters.activeJobId = id;
    page.search();
    expect(page.query.refresh).toHaveBeenCalledOnce();
    expect(page.activeQuery.refresh).toHaveBeenCalledOnce();
  });
  it('空白注册表单带入共用默认代理，已有手动选择不被覆盖', () => {
    page.options.data.value = { defaultProxyId: 'default-proxy' } as never;
    page.openStart();
    expect(page.draft.form.proxyId).toBe('default-proxy');
    page.draft.form.proxyId = 'manual-proxy';
    page.formOpen.value = false;
    page.openStart();
    expect(page.draft.form.proxyId).toBe('manual-proxy');
  });
  it('执行器不可用时创建失败并保留草稿', async () => {
    page.openStart();
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.create.mockRejectedValueOnce(new Error('内置浏览器尚未就绪'));
    await page.start();
    expect(mock.launch).not.toHaveBeenCalled();
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
  });
  it('后端确认接收后才清除提交快照，密码不进入会话草稿', async () => {
    page.openStart();
    Object.assign(page.draft.form, {
      mailboxAliasId: 'mail-1',
      proxyId: id,
      birthDate: '1996-01-01',
      confirmIdentity: true
    });
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).toHaveBeenCalledWith(id);
    expect(mock.connector).not.toHaveBeenCalled();
    expect(page.formOpen.value).toBe(false);
    page.openStart();
    expect(page.draft.form.mailboxAliasId).toBe('');
    expect(page.draft.form).not.toHaveProperty('password');
  });
  it('提交失败保留输入及任务编号，不标记成功', async () => {
    page.openStart();
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.launch.mockResolvedValueOnce({ id, attempt: 1, delivery: 'unknown' });
    await page.start();
    expect(page.formOpen.value).toBe(true);
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
    expect(page.filters.activeJobId).toBe(id);
  });
  it('页面只读取任务进度，自动取码由后端完成；退出停止进度刷新', async () => {
    page.filters.activeJobId = id;
    activeRow.value = { ...baseJob, state: 'awaiting_email', step: 'email_code' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(8000);
    expect(mock.code).not.toHaveBeenCalled();
    expect(page.activeQuery.refresh).toHaveBeenCalledOnce();
    scope.stop();
    await vi.advanceTimersByTimeAsync(16000);
    expect(page.activeQuery.refresh).toHaveBeenCalledOnce();
  });
  it('手动验证码绑定当前尝试和步骤，通过后端提交', async () => {
    page.filters.activeJobId = id;
    activeRow.value = { ...baseJob, state: 'awaiting_email', step: 'email_code' };
    page.loginCode.value = '123456';
    await nextTick();
    await page.manualSubmit();
    expect(mock.code).toHaveBeenCalledWith(id, { code: '123456', attempt: 1, step: 'email_code' });
    expect(page.loginCode.value).toBe('');
    expect(mock.connector).not.toHaveBeenCalled();
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
  it('取消关闭未确认时保留明确提示，并读取撤销后的任务状态', async () => {
    mock.cancel.mockResolvedValueOnce({ id, attempt: 1, delivery: 'unknown' });
    await page.act(baseJob, 'cancel');
    expect(page.error.value).toContain('浏览器关闭尚未确认');
    expect(page.query.refresh).toHaveBeenCalled();
  });
  it('列表翻页后仍读取当前任务，不使用其他任务的旧详情', async () => {
    page.filters.activeJobId = id;
    rows.value.items = [];
    activeRow.value = { ...baseJob, state: 'awaiting_email', step: 'email_code' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.selected.value?.id).toBe(id);
    expect(mock.code).not.toHaveBeenCalled();
    page.filters.activeJobId = '22222222-2222-4222-8222-222222222222';
    await nextTick();
    expect(page.selected.value).toBeUndefined();
  });
});
