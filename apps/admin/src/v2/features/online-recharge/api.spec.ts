import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configGroups } from './configFields';
import { onlineActionAllowedForRow, rowActions } from './sections';
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
});
