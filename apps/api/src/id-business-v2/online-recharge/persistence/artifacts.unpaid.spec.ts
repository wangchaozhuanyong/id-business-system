import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { OnlineRechargeArtifactsRepository } from './artifacts.repository';
import { sanitize } from '../validation';
const project = resolve(__dirname, '../../../../../..');
const engineModule = createRequire(resolve(__dirname, 'artifacts.unpaid.spec.ts'));
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
  it('首次和首页真实回执通过原附件接口保存，保留自动处理停点', async () => {
    const root = join(project, '.runtime/session-probe-repair-20261026/artifacts');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'fixture-'));
    try {
      const bootstrapDiagnostics = {
        initialSessionProbe: {
          state: 'challenge',
          httpStatus: 403,
          cfMitigated: 'challenge',
          complete: true,
          automaticResult: 'solver_disabled',
          automaticAttempted: false
        },
        homepageSessionProbe: { httpStatus: 200, hasValidUser: true, matchesTargetAccount: true }
      };
      const f = fixture(directory);
      const uploaded = await f.repository.upload(input({ ...report, bootstrapDiagnostics }));
      const { readFile } = await import('node:fs/promises');
      expect(
        JSON.parse(await readFile(join(directory, uploaded.filename), 'utf8')).bootstrapDiagnostics
      ).toEqual(bootstrapDiagnostics);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const bootstrapDiagnostics of [
    { rawBody: 'synthetic-private' },
    { initialSessionProbe: { httpStatus: 403, body: 'synthetic-private' } },
    { initialSessionProbe: { state: 'synthetic-private' } },
    { initialSessionProbe: { elapsedMs: 4242424242424242 } },
    { initialSessionProbe: ['synthetic-private'] },
    { automaticResult: 'synthetic-private' }
  ])
    it('登录诊断附件拒绝夹带正文、凭据及未知枚举', async () => {
      const f = fixture(join(project, '.runtime/session-probe-repair-20261026/artifacts'));
      await expect(f.repository.upload(input({ ...report, bootstrapDiagnostics }))).rejects.toThrow(
        '诊断文件字段无效'
      );
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
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

const countryTrace = {
  field: 'country',
  initialReason: 'outside_viewport',
  afterScrollReason: 'outside_viewport',
  tag: 'select',
  frameKind: 'embedded',
  frameId: 1,
  scroll: { state: 'completed', durationMs: 40 },
  pointChecks: [
    {
      scope: 'frame_owner',
      depth: 1,
      reason: 'outside_viewport',
      geometry: {
        left: 10,
        top: 900,
        width: 400,
        height: 200,
        viewportWidth: 1280,
        viewportHeight: 720
      }
    }
  ]
};
const countryDiagnostics = {
  inspection: { complete: true, interactionChecks: [countryTrace] },
  steps: [
    { field: 'country', phase: 'precheck', state: 'failed', tag: 'select', frameKind: 'embedded' }
  ]
};
const uploadDiagnostics = [
  { kind: 'diagnostic', outcome: 'failed', reason: 'http_error', httpStatus: 500, durationMs: 30 },
  { kind: 'batch', outcome: 'skipped', reason: 'deadline_exhausted', remainingFiles: 20 }
];
describe('国家控件交互和附件上传诊断贯通', () => {
  it('保留视口位置和固定上传错误，无须真实任务或数据库', async () => {
    const root = join(project, '.runtime/country-evidence-20261025/api-artifacts');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'fixture-'));
    try {
      const f = fixture(directory);
      const value = {
        ...report,
        lastStage: 'billing_fill',
        failureClass: 'BILLING_FILL_FAILED',
        failureCode: 'CHECKOUT_CONTROL_BLOCKED',
        missing: ['country'],
        formDiagnostics: countryDiagnostics,
        evidenceUploads: uploadDiagnostics
      };
      const result = await f.repository.upload(input(value));
      const { readFile } = await import('node:fs/promises');
      const saved = JSON.parse(await readFile(join(directory, result.filename), 'utf8'));
      expect(saved.formDiagnostics).toEqual(countryDiagnostics);
      expect(saved.evidenceUploads).toEqual(uploadDiagnostics);
      expect(saved.submitted).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const trace of [
    { ...countryTrace, inputValue: 'PRIVATE' },
    { ...countryTrace, scroll: { ...countryTrace.scroll, message: 'PRIVATE' } },
    {
      ...countryTrace,
      pointChecks: [{ ...countryTrace.pointChecks[0], geometry: { top: 'PRIVATE' } }]
    },
    { ...countryTrace, pointChecks: Array(9).fill(countryTrace.pointChecks[0]) }
  ])
    it('拒绝交互记录中的原始资料和超出界限的数据', async () => {
      const f = fixture(join(project, '.runtime/country-evidence-20261025/api-artifacts'));
      await expect(
        f.repository.upload(
          input({
            ...report,
            formDiagnostics: {
              ...countryDiagnostics,
              inspection: { complete: true, interactionChecks: [trace] }
            }
          })
        )
      ).rejects.toThrow('诊断文件字段无效');
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
  for (const evidenceUploads of [
    [{ ...uploadDiagnostics[0], responseBody: 'PRIVATE' }],
    [{ ...uploadDiagnostics[0], reason: 'PRIVATE' }],
    [{ ...uploadDiagnostics[0], httpStatus: 999 }],
    Array(33).fill(uploadDiagnostics[0])
  ])
    it('拒绝上传原始异常、正文、无效状态和无界记录', async () => {
      const f = fixture(join(project, '.runtime/country-evidence-20261025/api-artifacts'));
      await expect(f.repository.upload(input({ ...report, evidenceUploads }))).rejects.toThrow(
        '诊断文件字段无效'
      );
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
});

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

describe('代理与专用浏览器失败分类落盘', () => {
  for (const failureCode of ['NETWORK_TIMEOUT', 'NETWORK_UNAVAILABLE'])
    it(`保留订阅读取分类 ${failureCode}`, async () => {
      const root = join(project, '.runtime/subscription-body-fallback-20261027/api-artifacts');
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, 'fixture-'));
      try {
        const f = fixture(directory);
        const result = await f.repository.upload(
          input({
            ...report,
            lastStage: 'preflight',
            failureClass: 'NETWORK_READ_FAILED',
            failureCode
          })
        );
        const { readFile } = await import('node:fs/promises');
        const saved = JSON.parse(await readFile(join(directory, result.filename), 'utf8'));
        expect(saved.failureClass).toBe('NETWORK_READ_FAILED');
        expect(saved.failureCode).toBe(failureCode);
        expect(saved.submitted).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  for (const code of [
    'PROXY_CONNECTION_FAILED',
    'PROFILE_IDENTITY_MISSING',
    'PROFILE_PROXY_INVALID',
    'PROFILE_BUSY',
    'PROFILE_EXIT_CHANGED',
    'PROFILE_BINDING_INVALID',
    'PROFILE_DIRECTORY_INVALID',
    'PROFILE_LAUNCH_FAILED',
    'PROFILE_CLEANUP_FAILED'
  ])
    it(`保存受控分类 ${code}，不丢成未知`, async () => {
      const root = join(project, '.runtime/proxy-failure-evidence-20261025/api-artifacts');
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, 'fixture-'));
      try {
        const f = fixture(directory);
        const data = {
          ...report,
          lastStage: 'proxy',
          failureClass: [
            'PROXY_CONNECTION_FAILED',
            'PROFILE_PROXY_INVALID',
            'PROFILE_EXIT_CHANGED'
          ].includes(code)
            ? 'PROXY_UNAVAILABLE'
            : 'BROWSER_PROFILE_UNAVAILABLE',
          failureCode: code
        };
        const result = await f.repository.upload(input(data));
        const { readFile } = await import('node:fs/promises');
        const saved = JSON.parse(await readFile(join(directory, result.filename), 'utf8'));
        expect(saved.failureCode).toBe(code);
        expect(saved.failureClass).toBe(data.failureClass);
        expect(saved.submitted).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  it('未知前缀不扩大允许列表', async () => {
    const f = fixture(join(project, '.runtime/proxy-failure-evidence-20261025/api-artifacts'));
    await expect(
      f.repository.upload(input({ ...report, failureCode: 'PROFILE_PRIVATE_ARBITRARY' }))
    ).rejects.toThrow('诊断文件字段无效');
    expect(f.workers.withLease).not.toHaveBeenCalled();
  });
});

const diagnostics = engineModule('../engine/unpaid-validation.cjs') as {
  boundedReport: (report: unknown) => Record<string, unknown>;
  DIAGNOSTIC_MAX_BYTES: number;
};
function syntheticCheckoutReport() {
  const event = (index: number, kind = 'request_failed', endpoint = 'stripe_script') => ({
    event: kind,
    endpoint,
    frame: 'embedded',
    elapsedMs: 2000 + index,
    method: 'GET',
    frameId: 2,
    requestId: index + 1,
    resourceType: 'script',
    ownerEndpoint: 'stripe_frame',
    routeTemplate: 'other',
    startedMs: index,
    durationMs: 2000,
    ...(kind === 'request_failed'
      ? { code: 'TIMEOUT', failureCode: 'ERR_TIMED_OUT', source: 'network_or_proxy' }
      : {})
  });
  const lastReadFailure = {
    phase: 'load_state',
    reason: 'timeout',
    probe: 'load_precheck',
    readOperation: 'load_error_count',
    frameKind: 'embedded',
    frameId: 2,
    attempt: 2,
    enumerationIndex: 2,
    frameCount: 6,
    count: 1
  };
  return {
    ...report,
    lastStage: 'checkout_open',
    failureClass: 'READ_INCOMPLETE',
    failureCode: 'CHECKOUT_CONTROL_READ_FAILED',
    missing: [],
    timeline: [
      'input',
      'proxy',
      'login',
      'preflight',
      'card_readiness',
      'checkout_create',
      'checkout_open',
      'cleanup'
    ].map((stage) => ({
      stage,
      startedAt: '2026-10-24T01:00:00.000Z',
      endedAt: '2026-10-24T01:00:01.000Z',
      state: stage === 'checkout_open' ? 'failed' : 'completed'
    })),
    bootstrapDiagnostics: {
      initialSessionProbe: {
        httpStatus: 200,
        hasValidUser: true,
        matchesTargetAccount: true,
        complete: true
      },
      homepageSessionProbe: {
        httpStatus: 200,
        hasValidUser: true,
        matchesTargetAccount: true,
        complete: true
      }
    },
    checkoutOpenDiagnostics: {
      stage: 'readiness',
      reason: 'not_ready',
      code: 'CHECKOUT_CONTROL_READ_FAILED',
      missing: [],
      controls: [],
      previousCardReadiness: { ready: false, missing: ['number'], complete: true, scanned: 1 },
      inspection: {
        complete: false,
        timedOut: false,
        framesFailed: 1,
        readPhase: 'frame_scan',
        readAttempts: 2,
        readFailures: [{ ...lastReadFailure, attempt: 1 }, lastReadFailure],
        lastReadFailure,
        readAttemptSummaries: [1, 2].map((attempt) => ({
          attempt,
          frameCount: 6,
          framesChecked: 1,
          framesSkipped: 3,
          framesFailed: 1,
          complete: false,
          durationMs: 10
        }))
      },
      initialization: {
        version: 2,
        elapsedMs: 26711,
        eventCount: 533,
        readFailures: 0,
        truncated: true,
        events: Array.from({ length: 64 }, (_, i) => event(i)),
        firstFailure: event(0),
        criticalEvents: Array.from({ length: 96 }, (_, i) => event(i)),
        criticalEventCount: 123,
        criticalTruncated: true,
        failureClasses: Array.from({ length: 32 }, (_, i) => ({
          ...event(i),
          count: 2,
          lastElapsedMs: i === 0 ? 9999 : 3000 + i
        })),
        failureClassesTruncated: false,
        pendingRequests: Array.from({ length: 48 }, (_, i) =>
          event(i, 'request', i % 2 ? 'stripe_script' : 'stripe_frame')
        ),
        pendingRequestCount: 100,
        pendingRequestsTruncated: true,
        requestCounts: ['stripe_script', 'stripe_frame'].map((endpoint) => ({
          endpoint,
          started: 100,
          responses: 80,
          finished: 40,
          failed: 2,
          pending: 58
        }))
      },
      awaits: {
        version: 1,
        elapsedMs: 26711,
        steps: Array.from({ length: 48 }, (_, i) => ({
          step: 'readiness',
          state: i === 46 ? 'read_failed' : i === 47 ? 'pending' : 'completed',
          startedMs: i,
          remainingMs: 1000,
          ...(i === 46 ? { errorClass: 'timeout' } : {})
        }))
      }
    }
  };
}
describe('付款页诊断合同与字节裁剪', () => {
  it('合成大报告经执行器裁剪后由API保存，完整保留业务判断和阶段概要', async () => {
    const original = syntheticCheckoutReport(),
      before = JSON.stringify(original);
    expect(Buffer.byteLength(before)).toBeGreaterThan(42156);
    const bounded = diagnostics.boundedReport(original);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      diagnostics.DIAGNOSTIC_MAX_BYTES
    );
    expect(JSON.stringify(original)).toBe(before);
    for (const key of [
      'lastStage',
      'failureCode',
      'failureClass',
      'outcome',
      'missing',
      'timeline',
      'cardVerified',
      'billingVerified',
      'buttonReady',
      'submitted',
      'executorTerminated',
      'bootstrapDiagnostics'
    ] as const)
      expect(bounded[key]).toEqual(original[key]);
    const open = bounded.checkoutOpenDiagnostics as typeof original.checkoutOpenDiagnostics;
    expect(open.inspection.lastReadFailure).toEqual(
      original.checkoutOpenDiagnostics.inspection.lastReadFailure
    );
    expect(open.inspection.readFailures.map((row) => row.attempt)).toEqual([1, 2]);
    expect(open.previousCardReadiness).toEqual(
      original.checkoutOpenDiagnostics.previousCardReadiness
    );
    expect(open.inspection.readAttemptSummaries).toEqual(
      original.checkoutOpenDiagnostics.inspection.readAttemptSummaries
    );
    expect(open.initialization.firstFailure).toEqual(
      original.checkoutOpenDiagnostics.initialization.firstFailure
    );
    expect(open.initialization.requestCounts).toEqual(
      original.checkoutOpenDiagnostics.initialization.requestCounts
    );
    expect(open.initialization.eventCount).toBe(533);
    expect(open.initialization.pendingRequestCount).toBe(100);
    expect(open.initialization.failureClasses.some((row) => row.lastElapsedMs === 9999)).toBe(true);
    for (const endpoint of ['stripe_script', 'stripe_frame'])
      expect(open.initialization.pendingRequests.some((row) => row.endpoint === endpoint)).toBe(
        true
      );
    expect(open.awaits.steps.some((row) => row.state === 'read_failed')).toBe(true);
    expect(open.awaits.steps.some((row) => row.state === 'pending')).toBe(true);
    expect(bounded.diagnosticsTruncated).toBe(true);
    const root = join(project, '.runtime/checkout-read-evidence-20261027/artifacts');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'fixture-'));
    try {
      const f = fixture(directory);
      const result = await f.repository.upload(input(bounded));
      const { readFile } = await import('node:fs/promises');
      expect(JSON.parse(await readFile(join(directory, result.filename), 'utf8'))).toEqual(bounded);
      expect(f.tx.onlineRechargeEvent.create).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('未裁剪的超限报告仍被拒绝，不扩展32KB附件上限', async () => {
    const f = fixture(join(project, '.runtime/checkout-read-evidence-20261027/artifacts'));
    await expect(f.repository.upload(input(syntheticCheckoutReport()))).rejects.toThrow(
      /大小限制|过大/
    );
    expect(f.workers.withLease).not.toHaveBeenCalled();
  });
  for (const location of [
    'open',
    'inspection',
    'readFailure',
    'attemptSummary',
    'previousCard',
    'event',
    'await',
    'metadata'
  ])
    it(`拒绝${location}中的未知字段和原始内容`, async () => {
      const bounded = diagnostics.boundedReport(syntheticCheckoutReport());
      const open = bounded.checkoutOpenDiagnostics as Record<string, unknown>;
      const inspection = open.inspection as Record<string, unknown>;
      if (location === 'previousCard')
        (open.previousCardReadiness as Record<string, unknown>).rawValue = 'SYNTHETIC_PRIVATE';
      if (location === 'open') open.rawBody = 'SYNTHETIC_PRIVATE';
      if (location === 'inspection') inspection.rawValue = 'SYNTHETIC_PRIVATE';
      if (location === 'readFailure')
        (inspection.lastReadFailure as Record<string, unknown>).message = 'SYNTHETIC_PRIVATE';
      if (location === 'attemptSummary')
        (inspection.readAttemptSummaries as Record<string, unknown>[])[0].rawMessage =
          'SYNTHETIC_PRIVATE';
      if (location === 'event')
        (open.initialization as { firstFailure: Record<string, unknown> }).firstFailure.url =
          'https://example.invalid/SYNTHETIC_PRIVATE';
      if (location === 'await')
        (open.awaits as { steps: Record<string, unknown>[] }).steps.at(-1)!.rawMessage =
          'SYNTHETIC_PRIVATE';
      if (location === 'metadata') bounded.diagnosticsOmitted = ['SYNTHETIC_PRIVATE'];
      const f = fixture(join(project, '.runtime/checkout-read-evidence-20261027/artifacts'));
      await expect(f.repository.upload(input(bounded))).rejects.toThrow('诊断文件字段无效');
      expect(f.workers.withLease).not.toHaveBeenCalled();
    });
});

it('加载预检异常经执行器投影与API结果投影后保留真实操作，原始内容不回显', () => {
  const projection = engineModule('../engine/upstream/chatgpt.js') as {
    safeCheckoutOpenDiagnostics: (input: unknown) => Record<string, unknown>;
  };
  const failure = {
    phase: 'load_state',
    reason: 'timeout',
    probe: 'load_precheck',
    readOperation: 'load_error_visibility',
    frameKind: 'embedded',
    frameId: 2,
    count: 1,
    rawMessage: 'SYNTHETIC_PRIVATE'
  };
  const result = sanitize({
    checkoutOpenDiagnostics: projection.safeCheckoutOpenDiagnostics({
      stage: 'readiness',
      reason: 'not_ready',
      code: 'CHECKOUT_CONTROL_READ_FAILED',
      missing: [],
      inspection: { readPhase: 'frame_scan', readFailures: [failure], lastReadFailure: failure }
    })
  }) as { checkoutOpenDiagnostics: { inspection: { lastReadFailure: Record<string, unknown> } } };
  expect(result.checkoutOpenDiagnostics.inspection.lastReadFailure.readOperation).toBe(
    'load_error_visibility'
  );
  expect(result.checkoutOpenDiagnostics.inspection.lastReadFailure.probe).toBe('load_precheck');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
});

for (const [key, invalid] of [
  ['attempt', 3],
  ['frameCount', -1],
  ['enumerationIndex', 10001]
] as const)
  it(`rejects invalid attempt metadata ${key} before acquiring a lease`, async () => {
    const bounded = diagnostics.boundedReport(syntheticCheckoutReport());
    const open = bounded.checkoutOpenDiagnostics as {
      inspection: { lastReadFailure: Record<string, unknown> };
    };
    open.inspection.lastReadFailure[key] = invalid;
    const f = fixture(join(project, '.runtime/checkout-frame-attempts-20261027/artifacts'));
    await expect(f.repository.upload(input(bounded))).rejects.toThrow('诊断文件字段无效');
    expect(f.workers.withLease).not.toHaveBeenCalled();
  });
