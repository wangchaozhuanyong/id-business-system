import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, type Ref, type EffectScope } from 'vue';
import type { AppleMailboxRow, AppleMailboxTask } from './contracts';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mark: vi.fn(),
  start: vi.fn(),
  task: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn(),
  invalidate: vi.fn(),
  queries: [] as Array<Record<string, unknown>>,
  auth: { writesAllowed: true, user: { roles: ['admin'] } }
}));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@/auth/sessionCoordinator', async () => {
  const { ref } = await import('vue');
  return { sessionCoordinator: { identityEpoch: ref(0), subscribeIdentityChange: () => () => {} } };
});
vi.mock('./api', () => ({
  autoRegistrationApi: {
    appleMailboxes: mocks.list,
    markAppleMailboxes: mocks.mark,
    startAppleMailbox: mocks.start,
    appleMailboxTask: mocks.task,
    cancelAppleMailboxTask: mocks.cancel,
    recoverAppleMailbox: mocks.recover
  }
}));
vi.mock('@/v2/composables/useV2Query', async () => {
  const { computed, ref } = await import('vue');
  return {
    invalidateV2Queries: mocks.invalidate,
    createV2QueryKey: JSON.stringify,
    useV2ModuleQuery: (options: unknown) => {
      const result = {
        data: ref(),
        error: ref(null),
        phase: ref('ready'),
        isInitialLoading: ref(false),
        isRefreshing: ref(false),
        hasCurrentData: ref(true),
        isParameterTransition: ref(false),
        displayedKey: ref('list'),
        refresh: vi.fn().mockResolvedValue(undefined),
        options,
        enabled: computed(() => true)
      };
      mocks.queries.push(result);
      return result;
    }
  };
});
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useAppleMailboxes } from './useAppleMailboxes';

const row: AppleMailboxRow = {
  aliasId: 'alias-1',
  email: 'hidden@example.invalid',
  primaryEmail: 'primary@example.invalid',
  mailboxStatus: 'ACTIVE',
  authorizationValid: true,
  primaryAvailable: true,
  registrationStatus: 'unregistered',
  registrationIp: null,
  registrationIpSource: null,
  note: null,
  source: 'manual',
  updatedAt: null,
  revision: 3,
  taskUuid: null,
  taskStatus: null,
  canRegister: true,
  blockedReason: null
};
const record = {
  revision: 4,
  registrationStatus: 'unregistered' as const,
  registrationIp: null,
  registrationIpSource: null,
  source: null,
  note: null,
  markedAt: null,
  operatorId: null,
  activeTaskUuid: 'task-1',
  lastTaskUuid: 'task-1',
  lastResultKind: null,
  taskStatus: 'running' as const
};
let scopes: EffectScope[] = [];
function createPage() {
  const scope = effectScope();
  scopes.push(scope);
  const page = scope.run(useAppleMailboxes)!;
  page.query.data.value = { items: [row], total: 1, page: 1, pageSize: 20 };
  return page;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  clearV2SessionDrafts();
  mocks.auth.writesAllowed = true;
  (sessionCoordinator.identityEpoch as Ref<number>).value = 0;
  mocks.mark.mockResolvedValue({ updated: 1 });
  mocks.start.mockResolvedValue({ taskUuid: 'task-1', record });
  mocks.recover.mockResolvedValue(record);
  mocks.cancel.mockResolvedValue({ accepted: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  scopes.forEach((scope) => scope.stop());
  scopes = [];
  vi.useRealTimers();
});

describe('苹果隐藏邮箱草稿、CAS 和任务生命周期', () => {
  it('批量标记可用性仅取决于当前结果中的选择，不把字段有效性作为选择条件', () => {
    const page = createPage();
    expect(page.hasSelection.value).toBe(false);
    page.setSelection([row]);
    expect(page.hasSelection.value).toBe(true);
    page.markDraft.form.registrationIp = 'invalid-ip';
    expect(page.hasSelection.value).toBe(true);
    page.query.data.value = { items: [], total: 0, page: 2, pageSize: 20 };
    expect(page.selectedIds.value).toEqual([row.aliasId]);
    expect(page.hasSelection.value).toBe(false);
    page.query.data.value = { items: [row], total: 1, page: 1, pageSize: 20 };
    page.toggleSelection(row, false);
    expect(page.hasSelection.value).toBe(false);
  });
  it('历史 IP 仅已注册时可编辑，无效输入仍可编辑并修正', () => {
    const page = createPage();
    page.openMark([row]);
    expect(page.registrationIpEditable.value).toBe(false);
    page.markDraft.form.registrationStatus = 'registered';
    expect(page.registrationIpEditable.value).toBe(true);
    page.markDraft.form.registrationIp = 'invalid-ip';
    expect(page.registrationIpEditable.value).toBe(true);
    expect(page.markValidation.value).toContain('IPv4');
    page.markDraft.form.registrationStatus = 'unknown';
    expect(page.registrationIpEditable.value).toBe(false);
  });
  it('按原始版本提交人工标记，历史 IP 未知可保存', async () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.registrationStatus = 'registered';
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledWith({
      items: [{ aliasId: 'alias-1', revision: 3 }],
      registrationStatus: 'registered',
      registrationIp: null,
      note: ''
    });
    expect(page.markOpen.value).toBe(false);
    expect(page.query.refresh).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith('auto-registration');
  });
  it('关闭重开保留人工输入与原始版本，不替换为最新响应', () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.note = '历史已注册';
    page.markOpen.value = false;
    page.openMark([{ ...row, revision: 8 }]);
    expect(page.markDraft.form.note).toBe('历史已注册');
    expect(page.markDraft.form.items[0]?.revision).toBe(3);
  });
  it('批量标记提交所有所选版本，改成未注册时不沿用历史 IP', async () => {
    const page = createPage();
    page.openMark([row, { ...row, aliasId: 'alias-2', revision: 9 }]);
    page.markDraft.form.registrationStatus = 'unregistered';
    page.markDraft.form.registrationIp = '203.0.113.10';
    await page.saveMark();
    expect(mocks.mark.mock.calls[0]?.[0]).toMatchObject({
      items: [
        { aliasId: 'alias-1', revision: 3 },
        { aliasId: 'alias-2', revision: 9 }
      ],
      registrationIp: null
    });
  });
  it('失败保留草稿并支持显式重试，不自动重放', async () => {
    mocks.mark.mockRejectedValueOnce(new Error('版本已变化，请刷新核对'));
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.note = '保留输入';
    await page.saveMark();
    expect(page.markOpen.value).toBe(true);
    expect(page.markDraft.form.note).toBe('保留输入');
    expect(page.actionError.value).toContain('版本已变化');
    expect(mocks.mark).toHaveBeenCalledOnce();
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledTimes(2);
  });
  it('保存期间继续编辑时迟到成功不清除输入或关闭抽屉', async () => {
    const pending = deferred<{ updated: number }>();
    mocks.mark.mockReturnValueOnce(pending.promise);
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.note = '提交快照';
    const save = page.saveMark();
    page.markDraft.form.note = '后续编辑';
    pending.resolve({ updated: 1 });
    await save;
    expect(page.markOpen.value).toBe(true);
    expect(page.markDraft.form.note).toBe('后续编辑');
  });
  it('身份变化后不应用保存结果或重新读取新身份数据', async () => {
    const pending = deferred<{ updated: number }>();
    mocks.mark.mockReturnValueOnce(pending.promise);
    const page = createPage();
    page.openMark([row]);
    const save = page.saveMark();
    (sessionCoordinator.identityEpoch as Ref<number>).value += 1;
    pending.resolve({ updated: 1 });
    await save;
    expect(page.feedback.value).toBe('');
    expect(page.query.refresh).not.toHaveBeenCalled();
  });
  it('待确认、已注册、停用和忙碌邮箱不发起注册请求', async () => {
    const page = createPage();
    for (const patch of [
      { registrationStatus: 'unknown' },
      { registrationStatus: 'registered' },
      { taskStatus: 'running' },
      { mailboxStatus: 'DISABLED' }
    ])
      await page.start({ ...row, ...patch } as AppleMailboxRow);
    expect(mocks.start).not.toHaveBeenCalled();
    await page.start(row);
    expect(mocks.start).toHaveBeenCalledWith({ aliasId: row.aliasId, revision: row.revision });
    expect(page.taskUuid.value).toBe('task-1');
  });
  it('恢复仅允许中断任务，沿用原始 CAS 版本', async () => {
    const page = createPage();
    await page.recover({ ...row, taskStatus: 'running' });
    expect(mocks.recover).not.toHaveBeenCalled();
    await page.recover({ ...row, taskStatus: 'interrupted' });
    expect(mocks.recover).toHaveBeenCalledWith({ aliasId: row.aliasId, revision: row.revision });
  });
  it('筛选、分页和排序在同一身份切页后恢复', async () => {
    const page = createPage();
    page.filters.q = 'hidden';
    page.filters.sortBy = 'email';
    await nextTick();
    page.changePage(4);
    page.changePageSize(50);
    page.changePage(4);
    const reopened = createPage();
    expect(reopened.filters).toMatchObject({ q: 'hidden', sortBy: 'email', page: 4, pageSize: 50 });
  });
  it('任务进度通过共享查询刷新，终态刷新列表，错误停止自动读取', async () => {
    vi.useFakeTimers();
    const page = createPage();
    page.taskUuid.value = 'task-1';
    const task: AppleMailboxTask = {
      taskUuid: 'task-1',
      status: 'running',
      logs: [],
      record,
      resultKind: null
    };
    page.taskQuery.data.value = task;
    await nextTick();
    await vi.advanceTimersByTimeAsync(2500);
    expect(page.taskQuery.refresh).toHaveBeenCalledOnce();
    page.taskQuery.data.value = { ...task, status: 'completed', resultKind: 'new_registration' };
    await nextTick();
    expect(page.query.refresh).toHaveBeenCalledOnce();
    page.taskQuery.data.value = task;
    page.taskQuery.error.value = new Error('读取失败');
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(page.taskQuery.refresh).toHaveBeenCalledOnce();
  });
  it('取消请求明确等待任务停止，不推断任务已取消', async () => {
    const page = createPage();
    page.taskUuid.value = 'task-1';
    page.taskQuery.data.value = {
      taskUuid: 'task-1',
      status: 'running',
      logs: [],
      record,
      resultKind: null
    };
    await page.cancelTask();
    expect(mocks.cancel).toHaveBeenCalledWith('task-1');
    expect(page.feedback.value).toContain('等待任务停止');
    expect(page.taskQuery.data.value.status).toBe('running');
  });
  it('参数转换期间禁止对旧结果注册或标记', async () => {
    const page = createPage();
    (mocks.queries[0]!.isParameterTransition as Ref<boolean>).value = true;
    page.openMark([row]);
    await page.start(row);
    expect(page.markOpen.value).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('批量选择包含执行中或中断记录时不打开标记抽屉', () => {
    const page = createPage();
    page.openMark([row, { ...row, aliasId: 'busy', taskStatus: 'running' }]);
    expect(page.markOpen.value).toBe(false);
    expect(page.actionError.value).toContain('解除占用');
  });
  it('非法 IP 不提交，错误显示后修正即可保存', async () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = 'bad-ip';
    await page.saveMark();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(page.actionError.value).toContain('IPv4');
    page.markDraft.form.registrationIp = '2001:db8::1';
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledOnce();
  });
  it('有效状态已计算后编辑无效 IP 会即时更新字段错误，修正后清除', () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = '203.0.113.10';
    expect(page.markValidation.value).toBe('');
    page.markDraft.form.registrationIp = 'invalid-ip';
    expect(page.markValidation.value).toContain('IPv4');
    page.markDraft.form.registrationIp = '2001:db8::1';
    expect(page.markValidation.value).toBe('');
  });
  it('成功只清理已提交草稿，重开读取当前版本与状态', async () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.note = '提交内容';
    await page.saveMark();
    page.openMark([{ ...row, revision: 4, registrationStatus: 'registered', note: '已保存' }]);
    expect(page.markDraft.form.items[0]?.revision).toBe(4);
    expect(page.markDraft.form.registrationStatus).toBe('registered');
    expect(page.markDraft.form.note).toBe('已保存');
  });
  it('版本冲突后显式恢复默认更新为当前版本，不在重开时偷偷更新', () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.note = '旧草稿';
    page.query.data.value = { items: [{ ...row, revision: 7 }], total: 1, page: 1, pageSize: 20 };
    expect(page.markDraft.form.items[0]?.revision).toBe(3);
    page.resetMark();
    expect(page.markDraft.form.items[0]?.revision).toBe(7);
    expect(page.markDraft.form.note).toBe('');
  });
  it('离页后迟到成功不清理当前草稿或读列表', async () => {
    const pending = deferred<{ updated: number }>();
    mocks.mark.mockReturnValueOnce(pending.promise);
    const page = createPage();
    page.openMark([row]);
    const save = page.saveMark();
    scopes[0]!.stop();
    pending.resolve({ updated: 1 });
    await save;
    expect(page.markOpen.value).toBe(true);
    expect(page.query.refresh).not.toHaveBeenCalled();
    expect(page.feedback.value).toBe('');
  });
});
