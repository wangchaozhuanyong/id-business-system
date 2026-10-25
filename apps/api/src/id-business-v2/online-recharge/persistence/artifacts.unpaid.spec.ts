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

const formDiagnostics = {
  inspection: {
    complete: false,
    framesFailed: 1,
    framesChecked: 2,
    readAttempts: 2,
    readPhase: 'candidate_eligibility',
    readFailures: [{ phase: 'control_snapshot', reason: 'timeout', count: 1 }],
    controlCounts: { scanned: 6, eligible: 3 }
  },
  steps: [
    { field: 'number', phase: 'readback', state: 'completed', matched: true },
    {
      field: 'expiry',
      phase: 'precheck',
      state: 'failed',
      readPhase: 'candidate_eligibility',
      errorClass: 'timeout',
      frameId: 2,
      frameKind: 'embedded',
      candidateCount: 1,
      visible: true,
      readOnly: false,
      inShadowRoot: false,
      locatorKind: 'autocomplete',
      tag: 'input',
      durationMs: 300
    }
  ]
};

describe('填卡读取诊断落盘', () => {
  it('允许字段阶段和完整读取分类通过现有证据入口保存', async () => {
    const root = join(project, '.runtime/card-read-diagnostics-20261025/api-artifacts');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'fixture-'));
    try {
      const f = fixture(directory);
      const data = {
        ...report,
        lastStage: 'card_fill',
        failureClass: 'READ_INCOMPLETE',
        failureCode: 'CHECKOUT_CONTROL_READ_FAILED',
        missing: ['expiry', 'cvc'],
        formDiagnostics
      };
      const result = await f.repository.upload(input(data));
      expect(result.kind).toBe('diagnostic');
      const { readFile } = await import('node:fs/promises');
      const saved = JSON.parse(await readFile(join(directory, result.filename), 'utf8'));
      expect(saved.formDiagnostics).toEqual(formDiagnostics);
      expect(saved.submitted).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const unsafe of [
    { ...formDiagnostics, rawBody: 'PRIVATE' },
    { ...formDiagnostics, steps: [{ ...formDiagnostics.steps[1], constructor: 'PRIVATE' }] },
    { ...formDiagnostics, inspection: { constructor: 'PRIVATE' } },
    { ...formDiagnostics, inspection: { ...formDiagnostics.inspection, value: 'PRIVATE' } },
    { ...formDiagnostics, steps: [{ ...formDiagnostics.steps[1], value: 'PRIVATE' }] },
    { ...formDiagnostics, steps: [{ ...formDiagnostics.steps[1], errorClass: 'PRIVATE' }] },
    { ...formDiagnostics, steps: Array(33).fill(formDiagnostics.steps[1]) },
    {
      ...formDiagnostics,
      inspection: { ...formDiagnostics.inspection, controlCounts: { secret: 1 } }
    }
  ])
    it('拒绝原始值、未允许异常、额外字段和无界数据', async () => {
      const f = fixture(join(project, '.runtime/card-read-diagnostics-20261025/api-artifacts'));
      await expect(
        f.repository.upload(input({ ...report, formDiagnostics: unsafe }))
      ).rejects.toThrow('诊断文件字段无效');
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
});
