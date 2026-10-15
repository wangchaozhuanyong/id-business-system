import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import type { ProxyTestTask } from './contracts';

const mocks = vi.hoisted(() => ({
  test: vi.fn(),
  testTasks: vi.fn(),
  queries: [] as Array<Record<string, unknown>>
}));
vi.mock('./api', () => ({ proxyPoolApi: mocks }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (cause: Error) => cause.message }));
vi.mock('@/auth/sessionCoordinator', async () => {
  const { ref } = await import('vue');
  return { sessionCoordinator: { identityEpoch: ref(0), subscribeIdentityChange: () => () => {} } };
});
vi.mock('@/v2/composables/useV2Query', async () => {
  const { ref } = await import('vue');
  return {
    createV2QueryKey: JSON.stringify,
    useV2ModuleQuery: (options: unknown) => {
      const query = {
        data: ref(),
        error: ref(null),
        refresh: vi.fn().mockResolvedValue(undefined),
        options
      };
      mocks.queries.push(query);
      return query;
    }
  };
});
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { isProxyTestActive, proxyTestTaskLabel, useProxyTests } from './useProxyTests';

const task: ProxyTestTask = {
  id: 'task-one',
  proxyId: 'proxy-one',
  status: 'queued',
  progress: 0,
  message: '等待执行',
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z'
};
let scopes: EffectScope[] = [];
function page() {
  const onSettled = vi.fn().mockResolvedValue(undefined);
  const ids = ref(['proxy-one']);
  const scope = effectScope();
  scopes.push(scope);
  const value = scope.run(() =>
    useProxyTests({ proxyIds: () => ids.value, enabled: () => true, onSettled })
  )!;
  return { value, scope, ids, onSettled };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  clearV2SessionDrafts();
  (sessionCoordinator.identityEpoch as Ref<number>).value = 0;
  mocks.test.mockResolvedValue({ tasks: [task], reused: false });
});
afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes = [];
});

describe('代理检测任务闭环', () => {
  it('等待执行、排队过久、执行、失败、成功按真实状态展示', () => {
    expect(proxyTestTaskLabel(task, Date.parse(task.createdAt) + 1000)).toBe('等待执行');
    expect(proxyTestTaskLabel(task, Date.parse(task.createdAt) + 120000)).toContain('任务仍在排队');
    expect(proxyTestTaskLabel({ ...task, status: 'running', progress: 35 })).toBe('检测中（35%）');
    expect(proxyTestTaskLabel({ ...task, status: 'failed', message: '代理认证失败' })).toBe(
      '代理认证失败'
    );
    expect(isProxyTestActive({ ...task, status: 'failed' })).toBe(false);
    expect(isProxyTestActive({ ...task, status: 'succeeded' })).toBe(false);
  });
  it('仅缺少连接版本的旧排队任务允许重新检测，运行中的旧任务仍保护', () => {
    const legacy = { ...task, requiresResubmission: true };
    expect(isProxyTestActive(legacy)).toBe(false);
    expect(proxyTestTaskLabel(legacy)).toContain('请重新检测');
    expect(isProxyTestActive({ ...legacy, status: 'running' })).toBe(true);
    expect(isProxyTestActive(task)).toBe(true);
  });
  it('当前连接变化后历史成功不计入成功，显示重新检测并允许重新提交', async () => {
    const { value } = page();
    const changed = {
      ...task,
      status: 'succeeded' as const,
      message: '检测成功',
      connectionChanged: true
    };
    value.query.data.value = { items: [changed], revalidateAt: null };
    await nextTick();
    expect(proxyTestTaskLabel(changed)).toBe('连接资料已修改，请重新检测');
    expect(isProxyTestActive(changed)).toBe(false);
    expect(isProxyTestActive({ ...changed, status: 'queued' })).toBe(false);
    expect(isProxyTestActive({ ...changed, status: 'running' })).toBe(true);
    expect(value.summary.value).toContain('连接资料已修改 1 个');
    expect(value.summary.value).not.toContain('成功');
    await value.start('proxy-one');
    expect(mocks.test).toHaveBeenCalledTimes(1);
  });
  it.each(['awaiting_credentials', 'awaiting_review'] as const)(
    '旧异常状态 %s 保留说明并允许重新检测',
    async (status) => {
      const { value } = page();
      const interrupted = { ...task, status };
      value.query.data.value = { items: [interrupted], revalidateAt: null };
      await nextTick();
      expect(isProxyTestActive(interrupted)).toBe(false);
      expect(value.hasActive.value).toBe(false);
      expect(proxyTestTaskLabel(interrupted)).toContain('重新检测');
      expect(value.summary.value).toContain('历史检测异常 1 个');
      await value.start('proxy-one');
      expect(mocks.test).toHaveBeenCalledTimes(1);
    }
  );
  it('排队回执后继续跟踪，不连续创建；终态刷新代理结果，失败可重试', async () => {
    const { value, onSettled } = page();
    await value.start('proxy-one');
    await nextTick();
    await value.start('proxy-one');
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(value.hasActive.value).toBe(true);
    value.query.data.value = {
      items: [
        { ...task, status: 'failed', message: '连接超时', updatedAt: '2026-10-15T00:01:00Z' }
      ],
      revalidateAt: null
    };
    await nextTick();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(value.hasActive.value).toBe(false);
    mocks.test.mockResolvedValue({
      tasks: [
        {
          ...task,
          id: 'task-two',
          createdAt: '2026-10-15T00:02:00Z',
          updatedAt: '2026-10-15T00:02:00Z'
        }
      ],
      reused: false
    });
    await value.start('proxy-one');
    expect(mocks.test).toHaveBeenCalledTimes(2);
    expect(value.taskFor('proxy-one')?.id).toBe('task-two');
  });
  it('任务读取使用服务端deadline，当前页与提交代理合并，重入保留监测对象', async () => {
    const { value, ids, scope } = page();
    await value.start('proxy-two');
    ids.value = ['proxy-two'];
    const options = mocks.queries[0].options as {
      query: (value: { signal: AbortSignal }) => Promise<unknown>;
      getRevalidateAt: (value: { revalidateAt: string | null }) => string | null;
    };
    const signal = new AbortController().signal;
    await options.query({ signal });
    expect(mocks.testTasks).toHaveBeenCalledWith(['proxy-one', 'proxy-two'], { signal });
    expect(options.getRevalidateAt({ revalidateAt: '2026-10-15T00:00:03Z' })).toBe(
      '2026-10-15T00:00:03Z'
    );
    expect(options.getRevalidateAt({ revalidateAt: null })).toBeNull();
    scope.stop();
    const reopened = page();
    const reopenedOptions = mocks.queries[1].options as {
      query: (value: { signal: AbortSignal }) => Promise<unknown>;
    };
    await reopenedOptions.query({ signal });
    expect(reopened.value.tasks.value).toEqual([]);
  });
  it('网络失败保留重试入口，关闭页面或切换身份忽略迟到回执', async () => {
    const { value } = page();
    mocks.test.mockRejectedValueOnce(new Error('暂时无法连接服务器'));
    await value.start();
    expect(value.failed.value).toBe(true);
    expect(value.submitting.value).toBe(false);
    let resolve!: (value: unknown) => void;
    mocks.test.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const pending = value.start();
    (sessionCoordinator.identityEpoch as Ref<number>).value++;
    resolve({ tasks: [task], reused: false });
    await pending;
    expect(value.tasks.value).toEqual([]);
    expect(value.query.refresh).not.toHaveBeenCalled();
    const closed = page();
    const late = closed.value.start();
    closed.scope.stop();
    resolve({ tasks: [task], reused: false });
    await late;
    expect(closed.value.tasks.value).toEqual([]);
  });
});
