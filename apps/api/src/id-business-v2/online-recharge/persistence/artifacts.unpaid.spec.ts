import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { OnlineRechargeArtifactsRepository } from './artifacts.repository';
const project = resolve(__dirname, '../../../../../..');
const report = {
  format: 'unpaid-validation-v1',
  startedAt: '2026-10-24T01:00:00.000Z',
  endedAt: '2026-10-24T01:00:01.000Z',
  lastStage: 'login',
  outcome: 'failed_with_class',
  failureClass: 'LOGIN_READ_FAILED',
  timeline: [
    { stage: 'login', startedAt: '2026-10-24T01:00:00.000Z', endedAt: '2026-10-24T01:00:01.000Z' }
  ],
  cardVerified: false,
  billingVerified: false,
  buttonReady: false,
  submitted: false,
  executorTerminated: true
};
function fixture(directory: string, operation = 'debug') {
  const tx = { onlineRechargeEvent: { create: vi.fn() } };
  const workers = {
    withLease: vi.fn(async (_rpc, work) =>
      work(tx, {
        id: 'fixture-task',
        operation,
        payload: { validationMode: 'ready_before_payment' }
      })
    )
  };
  const repository = new OnlineRechargeArtifactsRepository(
    {} as never,
    workers as never,
    { get: () => directory } as never
  );
  return { repository, workers, tx };
}
function input(value: unknown) {
  return {
    method: 'evidenceUpload',
    args: {
      redacted: true,
      kind: 'diagnostic',
      name: 'unpaid-validation.json',
      mimeType: 'application/json',
      dataBase64: Buffer.from(JSON.stringify(value)).toString('base64')
    }
  };
}
describe('不付款诊断文件合同', () => {
  it('有效受控报告通过原证据接口保存，不连接数据库', async () => {
    const root = join(project, '.runtime/unpaid-validation-20261024');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'artifact-'));
    try {
      const f = fixture(directory);
      const result = await f.repository.upload(input(report));
      expect(result.kind).toBe('diagnostic');
      expect(result.filename).toMatch(/\.json$/);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.tx.onlineRechargeEvent.create).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const extra of [
    { rawBody: 'forbidden' },
    { timeline: [{ stage: 'login', token: 'forbidden' }] },
    { failureClass: 'arbitrary sensitive string' }
  ])
    it('拒绝原始正文、凭据及非允许分类', async () => {
      const f = fixture(join(project, '.runtime/unpaid-validation-20261024'));
      await expect(f.repository.upload(input({ ...report, ...extra }))).rejects.toThrow(
        '诊断文件字段无效'
      );
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
  it('普通任务不能使用此类诊断写入', async () => {
    const f = fixture(join(project, '.runtime/unpaid-validation-20261024'), 'recharge');
    await expect(f.repository.upload(input(report))).rejects.toThrow('仅支持不付款验收任务');
  });
});
