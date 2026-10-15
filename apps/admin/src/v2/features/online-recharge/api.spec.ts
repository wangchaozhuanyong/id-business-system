import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configGroups } from './configFields';
import { onlineActionAllowedForRow, onlineActionPayload, rowActions } from './sections';
import type { OnlineQuery } from './contracts';
const client = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock('@/api/client', () => ({ http: client, request: (value: unknown) => value }));
vi.mock('@/v2/composables/useV2Query', () => ({
  withV2QueryInvalidation: (value: unknown) => value
}));
import { onlineApi } from './api';
describe('配置检测与执行器请求合同', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.post.mockResolvedValue({ id: 'test-job', status: 'queued', progress: 0 });
  });
  it('兑换提交、订阅查询及原任务读取全部使用带后台身份的同一客户端', async () => {
    const signal = new AbortController().signal;
    const session = '{"accessToken":"synthetic-session-not-a-real-credential"}';
    client.get.mockResolvedValue({
      maintenance: false,
      maxConcurrent: 2,
      active: 1,
      paymentRegion: 'PH'
    });
    expect(await onlineApi.publicConfig(signal)).toMatchObject({
      maintenanceMode: false,
      capacity: 2,
      activeJobs: 1,
      region: 'PH'
    });
    expect(client.get).toHaveBeenCalledWith('/id-business-v2/online-recharge/public/config', {
      signal
    });
    await onlineApi.verify('SYNTHETIC-CODE');
    await onlineApi.redeem('SYNTHETIC-CODE', session);
    await onlineApi.task('task-id', 'synthetic-task-token', signal);
    await onlineApi.query('SYNTHETIC-CODE');
    await onlineApi.publicSubscribe('task-id', 'synthetic-task-token');
    await onlineApi.subscription(session);
    expect(client.post.mock.calls).toEqual([
      [
        '/id-business-v2/online-recharge/public/verify',
        { code: 'SYNTHETIC-CODE' },
        { signal: undefined }
      ],
      [
        '/id-business-v2/online-recharge/public/redeem',
        { code: 'SYNTHETIC-CODE', session },
        { signal: undefined }
      ],
      [
        '/id-business-v2/online-recharge/public/task',
        { id: 'task-id', taskToken: 'synthetic-task-token' },
        { signal }
      ],
      [
        '/id-business-v2/online-recharge/public/query',
        { code: 'SYNTHETIC-CODE' },
        { signal: undefined }
      ],
      [
        '/id-business-v2/online-recharge/public/subscribe',
        { id: 'task-id', taskToken: 'synthetic-task-token' },
        { signal: undefined }
      ],
      ['/id-business-v2/online-recharge/public/subscription', { session }, { signal: undefined }]
    ]);
  });
  it.each([
    ['检测求解器', 'solver'],
    ['检测视觉模型', 'vlm'],
    ['检测打码平台', 'captcha_platform'],
    ['检测供应商连接', 'gpt_api'],
    ['查询余额与套餐', 'gpt_status'],
    ['发送测试通知', 'telegram'],
    ['查看求解器日志', 'solver_logs']
  ])('%s 提交相应执行器目标，排队响应保留未完成状态', async (label, target) => {
    const action = configGroups
      .flatMap((group) => group.tests ?? [])
      .find((item) => item.label === label);
    expect(action?.key).toBe(target);
    const result = await onlineApi.action('config', 'test', { target: action?.key });
    expect(client.post).toHaveBeenCalledWith('/id-business-v2/online-recharge/admin/config/test', {
      target
    });
    expect(result.status).toBe('queued');
    expect(result.progress).toBe(0);
    expect(result).not.toHaveProperty('result');
  });
  it('待核对原单只提交原任务编号，返回的是核对任务而不是重建付款', async () => {
    const action = rowActions.jobs?.find((item) => item.key === 'recheck');
    expect(action).toBeDefined();
    expect(action?.fields).toBeUndefined();
    expect(action?.confirm).toContain('不会再次提交付款');
    const result = await onlineApi.action('jobs', 'recheck', { id: 'original-job' });
    expect(client.post).toHaveBeenCalledWith('/id-business-v2/online-recharge/admin/jobs/recheck', {
      id: 'original-job'
    });
    expect(result).toMatchObject({ id: 'test-job', status: 'queued', progress: 0 });
    expect(client.post).toHaveBeenCalledTimes(1);
  });
  it('原单核对入口仅用于有会话资料的待核对任务', () => {
    const action = rowActions.jobs!.find((item) => item.key === 'recheck')!;
    const original = { id: 'original-job', status: 'awaiting_review', hasSession: true };
    expect(onlineActionAllowedForRow('jobs', action, original)).toBe(true);
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'awaiting_credentials'])
      expect(onlineActionAllowedForRow('jobs', action, { ...original, status })).toBe(false);
    expect(onlineActionAllowedForRow('jobs', action, { ...original, hasSession: false })).toBe(
      false
    );
    expect(onlineActionAllowedForRow('automation', action, original)).toBe(false);
  });

  it.each(['test', 'reload'])(
    '浏览器池 %s 不提交空套餐筛选，控制任务可以进入队列',
    async (action) => {
      const filters: OnlineQuery = {
        page: 1,
        pageSize: 20,
        keyword: '',
        status: '',
        plan: '',
        dispatched: '',
        sortOrder: 'desc'
      };
      const body = onlineActionPayload(filters, { id: 'browser-slot' });
      const result = await onlineApi.action('browser-pool', action, body);
      expect(client.post).toHaveBeenCalledWith(
        `/id-business-v2/online-recharge/admin/browser-pool/${action}`,
        { page: 1, pageSize: 20, sortOrder: 'desc', id: 'browser-slot' }
      );
      expect(body).not.toHaveProperty('plan');
      expect(filters.plan).toBe('');
      expect(result.status).toBe('queued');
    }
  );

  it('批量操作保留实际筛选和操作参数，零与 false 不会被当作空值丢弃', async () => {
    const filters = {
      page: 0,
      pageSize: 50,
      keyword: 'selected-batch',
      status: 'unused',
      plan: 'pro_20x',
      dispatched: 'false',
      sortOrder: 'asc' as const,
      enabled: false,
      startDate: undefined
    };
    const body = onlineActionPayload(filters, { ids: ['code-1'], count: 0, dispatch: false });
    await onlineApi.action('cdks', 'export', body);
    expect(client.post).toHaveBeenCalledWith('/id-business-v2/online-recharge/admin/cdks/export', {
      page: 0,
      pageSize: 50,
      keyword: 'selected-batch',
      status: 'unused',
      plan: 'pro_20x',
      dispatched: 'false',
      sortOrder: 'asc',
      enabled: false,
      ids: ['code-1'],
      count: 0,
      dispatch: false
    });
  });

  it.each(['', 'invalid-plan'])('明确传入的无效套餐 %j 仍交给服务端校验', async (plan) => {
    const body = onlineActionPayload(
      { page: 1, pageSize: 20, keyword: '', status: '', plan: 'plus' },
      { plan, id: 'browser-slot' }
    );
    client.post.mockRejectedValueOnce(new Error('套餐无效'));
    await expect(onlineApi.action('browser-pool', 'test', body)).rejects.toThrow('套餐无效');
    expect(client.post).toHaveBeenCalledWith(
      '/id-business-v2/online-recharge/admin/browser-pool/test',
      { page: 1, pageSize: 20, plan, id: 'browser-slot' }
    );
  });
});
