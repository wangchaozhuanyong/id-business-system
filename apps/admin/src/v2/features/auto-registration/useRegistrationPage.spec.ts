import { effectScope, nextTick, ref, type Ref } from 'vue';
import type { FormItemRule } from 'element-plus';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { V2RegistrationJob, V2RegistrationMailbox } from './contracts';
import { useRegistrationPage } from './useRegistrationPage';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { ApiError } from '@/api/apiError';
const mock = vi.hoisted(() => ({
  connector: vi.fn(),
  create: vi.fn(),
  launch: vi.fn(),
  pending: vi.fn(),
  job: vi.fn(),
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
    pending: mock.pending,
    job: mock.job,
    connection: mock.connection,
    code: mock.code,
    cancel: mock.cancel,
    resume: mock.resume
  }
}));
const id = '11111111-1111-4111-8111-111111111111';
const mailbox: V2RegistrationMailbox = {
  id: 'mail-1',
  email: 'test@example.invalid',
  primaryEmail: 'primary@example.invalid',
  status: 'ACTIVE',
  registered: false,
  accountId: null,
  accountUpdatedAt: null,
  note: null,
  updatedAt: '',
  canStart: true,
  startBlockedReason: null,
  pendingJobId: null
};
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
  mock.pending.mockResolvedValue(null);
  mock.job.mockResolvedValue(baseJob);
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
  it.each([undefined, 20, 25, 45])('年龄 %s 可通过表单校验并提交，不发送完整生日', async (age) => {
    page.openStart(mailbox);
    page.draft.form.age = age;
    page.draft.form.confirmIdentity = true;
    const done = vi.fn();
    const rule = (page.rules.age as FormItemRule[])[0]!;
    rule.validator!({} as never, age, done, {} as never, {} as never);
    expect(done).toHaveBeenCalledWith(undefined);
    await page.start();
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({ age, confirmIdentity: true })
    );
    expect(mock.create.mock.calls[0]![0]).not.toHaveProperty('birthDate');
    expect(mock.launch).toHaveBeenCalledWith(id);
  });
  it.each([19, 46, 25.5])('年龄 %s 在提交前显示字段校验错误', (age) => {
    const done = vi.fn();
    const rule = (page.rules.age as FormItemRule[])[0]!;
    rule.validator!({} as never, age, done, {} as never, {} as never);
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ message: '年龄须为 20 至 45 岁的整数' })
    );
  });
  it('条件不变时查询仍刷新列表和当前任务，避免关闭重试操作停留在旧状态', () => {
    page.filters.activeJobId = id;
    page.search();
    expect(page.query.refresh).toHaveBeenCalledOnce();
    expect(page.activeQuery.refresh).toHaveBeenCalledOnce();
  });
  it('空白注册表单带入共用默认代理，已有手动选择不被覆盖', () => {
    page.options.data.value = { defaultProxyId: 'default-proxy' } as never;
    page.openStart(mailbox);
    expect(page.draft.form.proxyId).toBe('default-proxy');
    page.draft.form.proxyId = 'manual-proxy';
    page.formOpen.value = false;
    page.openStart(mailbox);
    expect(page.draft.form.proxyId).toBe('manual-proxy');
  });
  it('执行器不可用时创建失败并保留草稿', async () => {
    page.openStart(mailbox);
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.create.mockRejectedValueOnce(new Error('内置浏览器尚未就绪'));
    await page.start();
    expect(mock.launch).not.toHaveBeenCalled();
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
  });
  it('后端确认接收后才清除提交快照，密码不进入会话草稿', async () => {
    page.openStart(mailbox);
    Object.assign(page.draft.form, {
      mailboxAliasId: 'mail-1',
      proxyId: id,
      age: 25,
      confirmIdentity: true
    });
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).toHaveBeenCalledWith(id);
    expect(mock.connector).not.toHaveBeenCalled();
    expect(page.formOpen.value).toBe(false);
    page.openStart(mailbox);
    expect(page.draft.form.mailboxAliasId).toBe(mailbox.id);
    expect(page.draft.form).not.toHaveProperty('password');
  });
  it('提交失败保留输入及任务编号，不标记成功', async () => {
    page.openStart(mailbox);
    page.draft.form.mailboxAliasId = 'mail-1';
    mock.launch.mockResolvedValueOnce({ id, attempt: 1, delivery: 'unknown' });
    await page.start();
    expect(page.formOpen.value).toBe(true);
    expect(page.draft.form.mailboxAliasId).toBe('mail-1');
    expect(page.filters.activeJobId).toBe(id);
  });
  it('派发结果未知后核对原任务，不重新创建或派发', async () => {
    page.openStart(mailbox);
    mock.launch.mockResolvedValueOnce({ id, attempt: 1, delivery: 'unknown' });
    await page.start();
    mock.pending.mockRejectedValue(new Error('邮箱服务暂不可用'));
    expect(page.startConfirmText.value).toBe('核对原任务');
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).toHaveBeenCalledOnce();
    expect(mock.pending).not.toHaveBeenCalled();
    expect(mock.job).toHaveBeenCalledWith(id);
    expect(page.filters.activeJobId).toBe(id);
  });
  it('创建响应丢失时查回原任务，保留草稿并等待原任务操作', async () => {
    page.openStart(mailbox);
    page.draft.form.age = 25;
    mock.create.mockRejectedValueOnce(new Error('网络中断'));
    mock.pending.mockResolvedValueOnce(baseJob);
    await page.start();
    expect(mock.launch).not.toHaveBeenCalled();
    expect(page.filters.activeJobId).toBe(id);
    expect(page.draft.form.age).toBe(25);
    expect(page.message.value).toContain('已找到原注册任务');
    expect(page.error.value).toBe('');
  });
  it('创建超时后的空核对保留不明状态，迟到任务只读接回原编号', async () => {
    let committed = false;
    mock.create.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('请求超时')), 15_000);
          setTimeout(() => {
            committed = true;
          }, 18_065);
        })
    );
    mock.pending.mockImplementation(async () => (committed ? baseJob : null));
    page.openStart(mailbox);
    page.draft.form.age = 25;
    const firstStart = page.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await firstStart;
    expect(page.startConfirmText.value).toBe('核对原任务');
    expect(page.error.value).toContain('创建结果暂不明确');
    expect(page.message.value).not.toContain('重新');
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3065);
    await page.start();
    expect(page.filters.activeJobId).toBe(id);
    expect(page.message.value).toContain('已找到原注册任务');
    expect(page.error.value).toBe('');
    expect(page.draft.form.age).toBe(25);
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).not.toHaveBeenCalled();
  });
  it('未取得任务编号时不能只因时间经过和核对为空而重新创建', async () => {
    page.openStart(mailbox);
    mock.create.mockRejectedValueOnce(new Error('网络中断'));
    await page.start();
    await vi.advanceTimersByTimeAsync(90_000);
    await page.start();
    expect(page.startConfirmText.value).toBe('核对原任务');
    expect(page.error.value).toContain('创建结果暂不明确');
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).not.toHaveBeenCalled();
  });
  it.each(['queued', 'running', 'awaiting_email'] as const)(
    '已知编号直接读取原任务 %s，不重新查邮箱或启动任务',
    async (state) => {
      page.openStart(mailbox);
      mock.launch.mockRejectedValueOnce(new Error('请求超时'));
      await page.start();
      mock.job.mockResolvedValueOnce({ ...baseJob, state });
      mock.pending.mockRejectedValue(new Error('邮箱服务暂不可用'));
      await page.start();
      expect(mock.job).toHaveBeenCalledWith(id);
      expect(mock.pending).not.toHaveBeenCalled();
      expect(page.filters.activeJobId).toBe(id);
      expect(page.message.value).toContain('已找到原注册任务');
      expect(mock.create).toHaveBeenCalledOnce();
      expect(mock.launch).toHaveBeenCalledOnce();
      expect(mock.resume).not.toHaveBeenCalled();
    }
  );
  it('原编号读取失败或返回其他编号时仍保留原任务，不回退创建', async () => {
    page.openStart(mailbox);
    mock.launch.mockRejectedValueOnce(new Error('请求超时'));
    await page.start();
    mock.job.mockRejectedValueOnce(new Error('任务暂不可读'));
    await page.start();
    expect(page.startConfirmText.value).toBe('核对原任务');
    mock.job.mockResolvedValueOnce({ ...baseJob, id: '22222222-2222-4222-8222-222222222222' });
    await page.start();
    expect(page.filters.activeJobId).toBe(id);
    expect(page.error.value).toContain('读取结果不一致');
    expect(mock.pending).not.toHaveBeenCalled();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).toHaveBeenCalledOnce();
  });
  it.each(['completed', 'cancelled'] as const)(
    '原任务 %s 后结束核对锁，提示刷新资格并保留输入',
    async (state) => {
      page.openStart(mailbox);
      page.draft.form.age = 25;
      mock.launch.mockRejectedValueOnce(new Error('请求超时'));
      await page.start();
      mock.job.mockResolvedValueOnce({ ...baseJob, state });
      await page.start();
      expect(page.startConfirmText.value).toBe('开始注册');
      expect(page.message.value).toContain('原任务已结束，请刷新邮箱状态');
      expect(page.draft.form.age).toBe(25);
      expect(mock.create).toHaveBeenCalledOnce();
      expect(mock.launch).toHaveBeenCalledOnce();
    }
  );
  it('明确校验失败且未查到任务时解除不明状态，保留错误和草稿', async () => {
    page.openStart(mailbox);
    page.draft.form.age = 25;
    mock.create.mockRejectedValueOnce(
      new ApiError('资料校验失败', {
        code: 'VALIDATION_FAILED',
        kind: 'validation',
        status: 400,
        retryable: false
      })
    );
    await page.start();
    expect(page.startConfirmText.value).toBe('开始注册');
    expect(page.error.value).toBe('资料校验失败');
    expect(page.message.value).toContain('请刷新邮箱状态');
    expect(page.draft.form.age).toBe(25);
    expect(mock.launch).not.toHaveBeenCalled();
  });
  it('服务错误响应不能证明未创建，不解除空核对的不明状态', async () => {
    page.openStart(mailbox);
    mock.create.mockRejectedValueOnce(
      new ApiError('网关暂不可用', {
        code: 'SERVICE_UNAVAILABLE',
        kind: 'transient',
        status: 504,
        retryable: true
      })
    );
    await page.start();
    expect(page.startConfirmText.value).toBe('核对原任务');
    expect(page.error.value).toContain('创建结果暂不明确');
    expect(mock.launch).not.toHaveBeenCalled();
  });
  it('创建和核对都失败时锁定为核对原任务，不能重建', async () => {
    page.openStart(mailbox);
    mock.create.mockRejectedValueOnce(new Error('网络中断'));
    mock.pending.mockRejectedValueOnce(new Error('核对失败'));
    await page.start();
    expect(page.startConfirmText.value).toBe('核对原任务');
    mock.pending.mockRejectedValueOnce(new Error('仍无法读取'));
    await page.start();
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.launch).not.toHaveBeenCalled();
  });
  it('校验尚未返回时连点也只创建一次', async () => {
    let finish!: (value: boolean) => void;
    page.formRef.value = {
      validate: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    } as never;
    page.openStart(mailbox);
    const start = page.start();
    await page.start();
    finish(true);
    await start;
    expect(mock.create).toHaveBeenCalledOnce();
  });
  it('邮箱草稿隔离，取消和切页不丢失各自年龄', () => {
    page.openStart(mailbox);
    page.draft.form.age = 25;
    page.openStart({ ...mailbox, id: 'mail-2', email: 'other@example.invalid' });
    expect(page.draft.form.age).toBeUndefined();
    page.draft.form.age = 26;
    page.openStart(mailbox);
    expect(page.draft.form.age).toBe(25);
    expect(page.draft.form.mailboxAliasId).toBe(mailbox.id);
  });
  it('派发后列表读取失败仍显示已接收，不把成功注册派发当失败', async () => {
    page.openStart(mailbox);
    vi.mocked(page.query.refresh).mockRejectedValueOnce(new Error('读取失败'));
    await page.start();
    expect(page.formOpen.value).toBe(false);
    expect(page.error.value).toBe('');
    expect(page.message.value).toContain('已接收注册任务');
    expect(page.message.value).toContain('任务列表读取失败');
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
    page.openStart(mailbox);
    page.draft.form.age = 25;
    page.loginCode.value = '123456';
    scope.stop();
    mock.index = 0;
    scope = effectScope();
    page = scope.run(() => useRegistrationPage({ moduleKey: 'auto-registration' }))!;
    page.openStart(mailbox);
    expect(page.draft.form.age).toBe(25);
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
