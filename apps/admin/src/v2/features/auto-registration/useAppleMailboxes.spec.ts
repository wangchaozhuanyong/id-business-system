import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, type Ref, type EffectScope } from 'vue';
import type { AppleMailboxRow, AppleMailboxTask } from './contracts';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resume: vi.fn(),
  mark: vi.fn(),
  start: vi.fn(),
  browserStart: vi.fn(),
  connectorHealth: vi.fn(),
  browserDispatch: vi.fn(),
  candidates: vi.fn(),
  task: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn(),
  batch: vi.fn(),
  sync: vi.fn(),
  localSave: vi.fn(),
  manualPreview: vi.fn(),
  manualSync: vi.fn(),
  authorizationResume: vi.fn(),
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
    resumeAppleMailboxTasks: mocks.resume,
    appleMailboxes: mocks.list,
    markAppleMailboxes: mocks.mark,
    startAppleMailbox: mocks.start,
    startAppleMailboxBrowser: mocks.browserStart,
    appleMailboxCandidates: mocks.candidates,
    appleMailboxTask: mocks.task,
    cancelAppleMailboxTask: mocks.cancel,
    recoverAppleMailbox: mocks.recover,
    startAppleMailboxBatch: mocks.batch,
    syncAppleMailboxTask: mocks.sync,
    saveAppleMailboxLocalAccount: mocks.localSave,
    previewManualMailboxSync: mocks.manualPreview,
    syncManualMailboxes: mocks.manualSync,
    resumeAppleMailboxAuthorization: mocks.authorizationResume
  }
}));
vi.mock('./browser-connector', () => ({
  checkRegistrationConnector: mocks.connectorHealth,
  dispatchRegistrationBrowser: mocks.browserDispatch
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
  mocks.auth.user.roles = ['admin'];
  (sessionCoordinator.identityEpoch as Ref<number>).value = 0;
  mocks.mark.mockResolvedValue({ updated: 1 });
  mocks.resume.mockResolvedValue({ resumed: 0, synchronized: 0 });
  mocks.start.mockResolvedValue({ taskUuid: 'task-1', record });
  mocks.browserStart.mockResolvedValue({
    taskUuid: 'browser-task',
    record,
    launchToken: 'synthetic-private-launch',
    callbackBaseUrl: 'https://example.invalid/callback',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  mocks.connectorHealth.mockResolvedValue({
    service: 'id-business-v2-auto-registration-connector',
    version: 1,
    ok: true
  });
  mocks.browserDispatch.mockResolvedValue(undefined);
  mocks.recover.mockResolvedValue(record);
  mocks.cancel.mockResolvedValue({ accepted: true });
  mocks.batch.mockResolvedValue({
    batchId: 'batch-1',
    taskUuids: ['task-1'],
    accepted: 1,
    skipped: []
  });
  mocks.sync.mockResolvedValue({ accountId: 'account-1', syncStatus: 'saved' });
  mocks.localSave.mockResolvedValue({ localSaveStatus: 'saved' });
  mocks.manualPreview.mockResolvedValue({
    items: [
      { aliasId: row.aliasId, email: row.email, revision: 3, status: 'create', accountId: null }
    ],
    total: 1,
    creatable: 1
  });
  mocks.manualSync.mockResolvedValue({
    items: [{ aliasId: row.aliasId, status: 'saved', accountId: 'account-1' }],
    synchronized: 1,
    failed: 0,
    skipped: 0
  });
  mocks.authorizationResume.mockResolvedValue({ taskUuid: 'task-1', record });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  scopes.forEach((scope) => scope.stop());
  scopes = [];
  vi.useRealTimers();
});

describe('苹果隐藏邮箱草稿、CAS 和任务生命周期', () => {
  function browserPage() {
    const page = createPage();
    vi.mocked(page.connectorQuery.refresh).mockImplementation(async () => {
      page.connectorQuery.data.value = await mocks.connectorHealth();
      return page.connectorQuery.data.value;
    });
    return page;
  }
  it('浏览器注册固定传递所选代理，失效选项不占用邮箱', async () => {
    const page = browserPage();
    page.browserOptions.proxyId = 'proxy-one';
    page.browserProxyQuery.data.value = {
      items: [],
      total: 0,
      available: 0,
      proxies: [{ id: 'proxy-one', label: '测试代理' }]
    };
    await page.startBrowser(row);
    expect(mocks.browserStart).toHaveBeenCalledWith({
      aliasId: row.aliasId,
      revision: row.revision,
      proxyId: 'proxy-one'
    });
    mocks.browserStart.mockClear();
    page.browserProxyQuery.data.value.proxies = [];
    await page.startBrowser(row);
    expect(mocks.browserStart).not.toHaveBeenCalled();
    expect(page.actionError.value).toContain('所选注册代理已变化');
  });
  it('浏览器注册先检查助手，再创建和派发同一任务；不调用协议注册', async () => {
    const page = browserPage();
    await page.startBrowser(row);
    expect(mocks.connectorHealth).toHaveBeenCalledOnce();
    expect(mocks.browserStart).toHaveBeenCalledWith({
      aliasId: row.aliasId,
      revision: row.revision
    });
    expect(mocks.connectorHealth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.browserStart.mock.invocationCallOrder[0]!
    );
    expect(mocks.browserStart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.browserDispatch.mock.invocationCallOrder[0]!
    );
    expect(mocks.browserDispatch).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(page.taskUuid.value).toBe('browser-task');
    expect(page.feedback.value).toContain('保留比特浏览器窗口');
    expect(
      JSON.stringify({
        filters: page.filters,
        mark: page.markDraft.form,
        task: page.taskUuid.value
      })
    ).not.toContain('synthetic-private-launch');
    expect(Object.keys(page).some((key) => /token|grant/i.test(key))).toBe(false);
  });
  it('助手未连接时不创建或占用邮箱任务', async () => {
    mocks.connectorHealth.mockRejectedValueOnce(new Error('助手离线'));
    const page = browserPage();
    await page.startBrowser(row);
    expect(mocks.browserStart).not.toHaveBeenCalled();
    expect(mocks.browserDispatch).not.toHaveBeenCalled();
    expect(page.taskUuid.value).toBe('');
    expect(page.busy.value).toBe(false);
  });
  it('派发失败保留服务端任务，提供原任务查看和取消，不自动重试或解除占用', async () => {
    mocks.browserDispatch.mockRejectedValueOnce(new Error('synthetic-private-launch'));
    const page = browserPage();
    await page.startBrowser(row);
    await nextTick();
    expect(page.taskUuid.value).toBe('browser-task');
    expect(page.actionError.value).toContain('任务已保留');
    expect(page.actionError.value).toContain('查看原任务或取消');
    expect(page.actionError.value).not.toContain('synthetic-private-launch');
    expect(mocks.browserStart).toHaveBeenCalledOnce();
    expect(mocks.browserDispatch).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('创建期间重复点击不会产生第二个浏览器任务', async () => {
    const pending = deferred<unknown>();
    mocks.browserStart.mockReturnValueOnce(pending.promise);
    const page = browserPage();
    const first = page.startBrowser(row);
    await nextTick();
    await page.startBrowser(row);
    pending.resolve({ taskUuid: 'browser-task', record });
    await first;
    expect(mocks.browserStart).toHaveBeenCalledOnce();
    expect(mocks.browserDispatch).toHaveBeenCalledOnce();
  });
  it('创建回执迟到且身份已变化时不把票据派发到助手或覆盖新身份任务', async () => {
    const pending = deferred<unknown>();
    mocks.browserStart.mockReturnValueOnce(pending.promise);
    const page = browserPage();
    const start = page.startBrowser(row);
    await nextTick();
    (sessionCoordinator.identityEpoch as Ref<number>).value += 1;
    pending.resolve({ taskUuid: 'late-task', record, launchToken: 'synthetic-private-launch' });
    await start;
    expect(mocks.browserDispatch).not.toHaveBeenCalled();
    expect(page.taskUuid.value).toBe('');
    expect(page.query.refresh).not.toHaveBeenCalled();
  });
  it('离页时取消本机派发读取，保留已创建的原任务', async () => {
    const pending = deferred<void>();
    mocks.browserDispatch.mockReturnValueOnce(pending.promise);
    const page = browserPage();
    const start = page.startBrowser(row);
    await vi.waitFor(() => expect(mocks.browserDispatch).toHaveBeenCalledOnce());
    const options = mocks.browserDispatch.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    scopes[0]!.stop();
    expect(options.signal.aborted).toBe(true);
    pending.resolve();
    await start;
    expect(page.feedback.value).toBe('');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('人工历史同步先预览，关闭重开保留原始版本，成功后使主台账重新读取', async () => {
    const page = createPage();
    page.setSelection([{ ...row, registrationStatus: 'registered' }]);
    page.openManualSync();
    expect(page.manualSyncDisabledReason.value).not.toBe('');
    const options = mocks.queries[2]!.options as {
      query: (input: { signal: AbortSignal }) => Promise<unknown>;
    };
    page.manualSyncQuery.data.value = (await options.query({
      signal: new AbortController().signal
    })) as never;
    expect(mocks.manualPreview).toHaveBeenCalledWith(
      [{ aliasId: 'alias-1', revision: 3 }],
      expect.anything()
    );
    page.manualSyncOpen.value = false;
    page.query.data.value = { items: [{ ...row, revision: 8 }], total: 1, page: 1, pageSize: 20 };
    page.setSelection([{ ...row, revision: 8 }]);
    page.openManualSync();
    await page.syncManualMailboxes();
    expect(mocks.manualSync).toHaveBeenCalledWith([{ aliasId: 'alias-1', revision: 3 }]);
    expect(page.manualSyncOpen.value).toBe(false);
    expect(page.feedback.value).toContain('缺失密码、注册 IP 和注册时间保留待补');
    expect(mocks.invalidate).toHaveBeenCalledWith('auto-recharge');
  });
  it('预览冲突或读取失败时不能写入历史同步', async () => {
    const page = createPage();
    page.setSelection([row]);
    page.openManualSync();
    page.manualSyncQuery.data.value = { items: [], total: 1, creatable: 0 };
    await page.syncManualMailboxes();
    expect(mocks.manualSync).not.toHaveBeenCalled();
    page.manualSyncQuery.data.value = { items: [], total: 1, creatable: 1 };
    (page.manualSyncQuery.error as Ref<Error | null>).value = new Error('预览不可用');
    await page.syncManualMailboxes();
    expect(mocks.manualSync).not.toHaveBeenCalled();
  });
  it('过期快照只有显式重新核对才更新版本，核对失败不替换原提交目标', async () => {
    const page = createPage();
    page.setSelection([row]);
    page.openManualSync();
    page.manualSyncQuery.data.value = { items: [], total: 1, creatable: 1 };
    page.query.data.value = { items: [{ ...row, revision: 8 }], total: 1, page: 1, pageSize: 20 };
    (page.query.error as Ref<Error | null>).value = new Error('读取失败');
    await page.refreshManualSyncPreview();
    expect(page.manualSyncDisabledReason.value).toContain('最新状态读取失败');
    const options = mocks.queries[2]!.options as {
      query: (input: { signal: AbortSignal }) => Promise<unknown>;
    };
    await options.query({ signal: new AbortController().signal });
    expect(mocks.manualPreview).toHaveBeenLastCalledWith(
      [{ aliasId: 'alias-1', revision: 3 }],
      expect.anything()
    );
    (page.query.error as Ref<Error | null>).value = null;
    await page.syncManualMailboxes();
    expect(mocks.manualSync).not.toHaveBeenCalled();
    await page.refreshManualSyncPreview();
    await page.syncManualMailboxes();
    expect(mocks.manualSync).toHaveBeenLastCalledWith([{ aliasId: 'alias-1', revision: 8 }]);
  });
  it('同步请求失败保留对话框和原始提交目标', async () => {
    const page = createPage();
    page.setSelection([row]);
    page.openManualSync();
    page.manualSyncQuery.data.value = { items: [], total: 1, creatable: 1 };
    mocks.manualSync.mockRejectedValueOnce(new Error('暂时不可用'));
    await page.syncManualMailboxes();
    expect(page.manualSyncOpen.value).toBe(true);
    expect(page.actionError.value).toBe('暂时不可用');
    await page.syncManualMailboxes();
    expect(mocks.manualSync).toHaveBeenLastCalledWith([{ aliasId: 'alias-1', revision: 3 }]);
  });
  it('只允许已创建且待授权的原任务继续授权，不触发重新注册', async () => {
    const page = createPage();
    const created = {
      ...row,
      taskUuid: 'task-1',
      taskStatus: 'failed' as const,
      creationConfirmed: true,
      authorizationStatus: 'pending' as const,
      registrationStatus: 'registered' as const
    };
    await page.resumeAuthorization(created);
    expect(mocks.authorizationResume).toHaveBeenCalledWith('task-1');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(page.feedback.value).toContain('原账号的登录与授权');
    await page.resumeAuthorization({ ...created, activeTaskUuid: 'task-1' });
    await page.resumeAuthorization({ ...created, creationConfirmed: false });
    expect(mocks.authorizationResume).toHaveBeenCalledOnce();
  });
  it('旧身份恢复请求迟到后不继续读取邮箱列表', async () => {
    const pending = deferred<{ resumed: number; synchronized: number }>();
    mocks.resume.mockReturnValueOnce(pending.promise);
    const page = createPage();
    const options = mocks.queries[0]!.options as {
      query: (context: { signal: AbortSignal }) => Promise<unknown>;
    };
    const read = options.query({ signal: new AbortController().signal });
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    (sessionCoordinator.identityEpoch as Ref<number>).value += 1;
    pending.resolve({ resumed: 0, synchronized: 0 });
    await rejected;
    expect(mocks.list).not.toHaveBeenCalled();
    expect(page.feedback.value).toBe('');
  });
  it.each(['batch', 'sync', 'localSave'] as const)(
    '%s 的迟到响应不更新新身份的选中任务、反馈或列表',
    async (action) => {
      const pending = deferred<unknown>();
      mocks[action].mockReturnValueOnce(pending.promise);
      const page = createPage();
      page.setSelection([row]);
      page.taskUuid.value = 'original-task';
      const write =
        action === 'batch'
          ? page.startBatch()
          : action === 'sync'
            ? page.syncTask()
            : page.saveLocalAccount();
      expect(mocks[action]).toHaveBeenCalledOnce();
      (sessionCoordinator.identityEpoch as Ref<number>).value += 1;
      pending.resolve(
        action === 'batch'
          ? { taskUuids: ['late-task'], accepted: 1, skipped: [] }
          : action === 'sync'
            ? { accountId: 'late-account', syncStatus: 'saved' }
            : { localSaveStatus: 'saved' }
      );
      await write;
      expect(page.taskUuid.value).toBe('original-task');
      expect(page.feedback.value).toBe('');
      expect(page.query.refresh).not.toHaveBeenCalled();
      expect(page.taskQuery.refresh).not.toHaveBeenCalled();
    }
  );
  it.each(['readonly', 'non-admin'] as const)(
    '%s 禁止批量注册、补同步和补存本地账号',
    async (reason) => {
      if (reason === 'readonly') mocks.auth.writesAllowed = false;
      else mocks.auth.user.roles = [];
      const page = createPage();
      page.setSelection([row]);
      page.taskUuid.value = 'task-1';
      await page.startBatch();
      await page.syncTask();
      await page.saveLocalAccount();
      expect(mocks.batch).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(mocks.localSave).not.toHaveBeenCalled();
    }
  );
  it('批量仅提交选中的可用未注册邮箱，绑定各自原始版本', async () => {
    const page = createPage();
    const second = { ...row, aliasId: 'alias-2', revision: 9 };
    const registered = { ...row, aliasId: 'registered', registrationStatus: 'registered' as const };
    page.query.data.value!.items = [row, second, registered];
    page.setSelection([row, second, registered]);
    await page.startBatch();
    expect(mocks.batch).toHaveBeenCalledWith({
      targets: [
        { aliasId: 'alias-1', revision: 3 },
        { aliasId: 'alias-2', revision: 9 }
      ],
      count: 2,
      concurrency: 3,
      mode: 'pipeline',
      interval_min: 5,
      interval_max: 30
    });
    expect(page.taskUuid.value).toBe('task-1');
    expect(page.feedback.value).toContain('跳过 1 个');
  });
  it('同步恢复只补主系统同步，不触发注册、批量或标记', async () => {
    const page = createPage();
    page.taskUuid.value = 'task-1';
    await page.syncTask();
    expect(mocks.sync).toHaveBeenCalledWith('task-1');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(page.feedback.value).toContain('ChatGPT');
  });
  it('补存本地账号使用原任务标识，不触发注册或主系统同步', async () => {
    const page = createPage();
    page.taskUuid.value = 'task-1';
    await page.saveLocalAccount();
    expect(mocks.localSave).toHaveBeenCalledWith('task-1');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(page.feedback.value).toContain('补存');
  });
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
  it('人工核对只打开确认框，确认后才解除待核对占用并沿用原始 CAS 版本', async () => {
    const page = createPage();
    page.openRecovery({ ...row, taskUuid: 'task-1', taskStatus: 'running' });
    await page.recover();
    expect(mocks.recover).not.toHaveBeenCalled();
    page.openRecovery({
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review'
    });
    expect(page.recoverOpen.value).toBe(true);
    expect(mocks.recover).not.toHaveBeenCalled();
    page.recoverOpen.value = false;
    await page.recover();
    expect(mocks.recover).not.toHaveBeenCalled();
    page.openRecovery({
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review'
    });
    await page.recover();
    expect(mocks.recover).toHaveBeenCalledWith({ aliasId: row.aliasId, revision: row.revision });
    expect(page.recoverOpen.value).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('已解除占用的历史中断记录可标记，待确认状态仍不能直接重新注册', async () => {
    const page = createPage();
    const released = {
      ...row,
      registrationStatus: 'unknown' as const,
      taskUuid: 'task-1',
      activeTaskUuid: null,
      taskStatus: 'interrupted' as const,
      revision: 4,
      canRegister: false
    };
    page.query.data.value = { items: [released], total: 1, page: 1, pageSize: 20 };
    page.openMark([released]);
    expect(page.markOpen.value).toBe(true);
    await page.start(released);
    expect(mocks.start).not.toHaveBeenCalled();
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = '203.0.113.9';
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledWith({
      items: [{ aliasId: row.aliasId, revision: 4 }],
      registrationStatus: 'registered',
      registrationIp: '203.0.113.9',
      note: ''
    });
  });
  it('核对失败和关闭重开保留原始版本，只有明确刷新才更新核对依据', async () => {
    const page = createPage();
    const reviewing = {
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'interrupted' as const
    };
    page.openRecovery(reviewing);
    mocks.recover.mockRejectedValueOnce(new Error('版本已变化'));
    await page.recover();
    expect(page.recoverOpen.value).toBe(true);
    expect(page.recoverDraft.form.target?.revision).toBe(3);
    page.recoverOpen.value = false;
    page.openRecovery({ ...reviewing, revision: 7 });
    expect(page.recoverDraft.form.target?.revision).toBe(3);
    page.query.data.value = {
      items: [{ ...reviewing, revision: 7 }],
      total: 1,
      page: 1,
      pageSize: 20
    };
    await page.refreshRecovery();
    await page.recover();
    expect(mocks.recover).toHaveBeenLastCalledWith({ aliasId: row.aliasId, revision: 7 });
  });
  it('身份切换后的解除回执不收起原确认框、不刷新或显示成功', async () => {
    const page = createPage();
    page.openRecovery({
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review'
    });
    const pending = deferred<typeof record>();
    mocks.recover.mockReturnValueOnce(pending.promise);
    const saving = page.recover();
    (sessionCoordinator.identityEpoch as Ref<number>).value += 1;
    pending.resolve(record);
    await saving;
    expect(page.feedback.value).toBe('');
    expect(page.recoverOpen.value).toBe(true);
    expect(page.query.refresh).not.toHaveBeenCalled();
  });
  it('刷新目标缺失或读取失败时禁止确认，明确重读成功才可继续', async () => {
    const page = createPage();
    const reviewing = {
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review' as const
    };
    page.openRecovery(reviewing);
    page.query.data.value = { items: [], total: 0, page: 1, pageSize: 20 };
    await page.refreshRecovery();
    expect(page.recoverDisabledReason.value).toContain('找不到');
    await page.recover();
    expect(mocks.recover).not.toHaveBeenCalled();
    const refresh = mocks.queries[0]!.refresh as ReturnType<typeof vi.fn>;
    refresh.mockRejectedValueOnce(new Error('读取失败'));
    await page.refreshRecovery();
    expect(page.recoverDisabledReason.value).not.toBe('');
    await page.recover();
    expect(mocks.recover).not.toHaveBeenCalled();
    page.query.data.value = {
      items: [{ ...reviewing, revision: 8 }],
      total: 1,
      page: 1,
      pageSize: 20
    };
    await page.refreshRecovery();
    expect(page.recoverDisabledReason.value).toBe('');
    await page.recover();
    expect(mocks.recover).toHaveBeenCalledWith({ aliasId: row.aliasId, revision: 8 });
  });
  it('实际查询保留旧内容但报告刷新错误时禁止确认', async () => {
    const page = createPage();
    page.openRecovery({
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review'
    });
    page.query.error.value = new Error('刷新失败');
    await page.refreshRecovery();
    expect(page.recoverDisabledReason.value).not.toBe('');
    await page.recover();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('含首次失败对象的响应式邮箱行关闭重开时不复制嵌套代理或丢失核对快照', () => {
    const page = createPage();
    const reviewing = reactive<AppleMailboxRow>({
      ...row,
      taskUuid: 'task-1',
      activeTaskUuid: 'task-1',
      taskStatus: 'awaiting_review',
      firstFailure: {
        stage: 'create_account',
        errorKind: 'network_error',
        httpStatus: null,
        elapsedMs: 50,
        observedAt: '2026-10-12T00:00:00Z'
      }
    });
    expect(() => page.openRecovery(reviewing)).not.toThrow();
    page.recoverOpen.value = false;
    expect(() => page.openRecovery({ ...reviewing, revision: 8 })).not.toThrow();
    expect(page.recoverDraft.form.target?.revision).toBe(3);
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
  it('占用中的结果待核对任务阻止直接标记，提示人工核对后解除', () => {
    const page = createPage();
    page.openMark([{ ...row, taskStatus: 'awaiting_review' }]);
    expect(page.markOpen.value).toBe(false);
    expect(page.actionError.value).toContain('查看任务');
    expect(page.actionError.value).toContain('人工核对后解除占用');
  });
  it('非法 IP 不提交，错误显示后修正即可保存', async () => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = 'bad-ip';
    await page.saveMark();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(page.markValidation.value).toContain('IPv4');
    expect(page.actionError.value).toBe('');
    page.markDraft.form.registrationIp = '2001:db8::1';
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledOnce();
  });
  it.each(['', '菲律宾'])('IP 可留空，备注可为空或填写地区：%s', async (note) => {
    const page = createPage();
    page.openMark([row]);
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = '菲律宾';
    await page.saveMark();
    expect(mocks.mark).not.toHaveBeenCalled();
    page.markDraft.form.registrationIp = '';
    page.markDraft.form.note = note;
    expect(page.markValidation.value).toBe('');
    expect(page.actionError.value).toBe('');
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledWith({
      items: [{ aliasId: row.aliasId, revision: row.revision }],
      registrationStatus: 'registered',
      registrationIp: null,
      note
    });
    expect(page.markOpen.value).toBe(false);
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
