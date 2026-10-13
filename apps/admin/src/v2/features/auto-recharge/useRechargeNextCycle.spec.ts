import { effectScope, ref, watch, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import type { V2RechargeJob } from './contracts';
import { useRechargeNextCycle } from './useRechargeNextCycle';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  health: vi.fn(),
  confirm: vi.fn(),
  paymentConfirm: vi.fn(),
  resume: vi.fn()
}));
vi.mock('./api', () => ({
  rechargeApi: { bitBrowserAccess: mocks.access, confirmNextCycle: mocks.confirm },
  rechargeConnectorApi: {
    health: mocks.health,
    confirm: mocks.paymentConfirm,
    resume: mocks.resume
  }
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: (options: {
    key: () => string;
    enabled: () => boolean;
    query: (context: { signal: AbortSignal }) => Promise<unknown>;
  }) => {
    const data = ref(),
      error = ref(),
      phase = ref('disabled');
    let generation = 0;
    let controller: AbortController | undefined;
    async function refresh() {
      if (!options.enabled()) return;
      const revision = ++generation;
      controller?.abort();
      controller = new AbortController();
      phase.value = 'initial-loading';
      try {
        const result = await options.query({ signal: controller.signal });
        if (revision !== generation) return;
        data.value = result;
        error.value = undefined;
        phase.value = 'ready';
      } catch (cause) {
        if (revision !== generation) return;
        error.value = cause;
        phase.value = 'initial-error';
      }
    }
    watch(
      [options.key, options.enabled],
      () => {
        if (options.enabled()) void refresh();
        else {
          generation++;
          controller?.abort();
          phase.value = 'disabled';
        }
      },
      { immediate: true, flush: 'sync' }
    );
    return { data, error, phase, refresh };
  }
}));

function makeJob(): V2RechargeJob {
  return {
    id: 'fixture-next-cycle-job',
    action: 'bitbrowser',
    plan: 'plus',
    state: 'awaiting_human_verification',
    createdAt: '',
    updatedAt: '',
    result: {
      mode: 'payment',
      stage: 'next_subscription_cycle_review',
      account_matched: true,
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      cycle_review: {
        protocol: 1,
        status: 'awaiting_previous_cycle_confirmation',
        reviewDigest: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      }
    }
  };
}
let scope: EffectScope;
let job = ref<V2RechargeJob | undefined>();
let api = ref(true);
let flow: ReturnType<typeof useRechargeNextCycle>;
let refreshed = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  job = ref(makeJob());
  api = ref(true);
  refreshed = vi.fn();
  mocks.access.mockImplementation(async () => ({
    connectorUrl: 'http://127.0.0.1:55444',
    connectorToken: 'fixture-owner-token'
  }));
  mocks.health.mockResolvedValue({ busy: true, capabilities: ['next-subscription-cycle-v1'] });
  mocks.confirm.mockResolvedValue({
    cycleReview: { ...job.value!.result.cycle_review, status: 'ready' }
  });
  scope = effectScope();
  flow = scope.run(() => useRechargeNextCycle(job, api, refreshed))!;
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});

async function ready() {
  await vi.waitFor(() => expect(flow.canOpen.value).toBe(true));
}

describe('旧订阅周期人工核实与付款授权分离', () => {
  it('原任务连接能力核对允许助手正在等待，人工确认只发送owner核实，不调用付款确认或继续接口', async () => {
    await ready();
    expect(mocks.access.mock.calls[0]?.[0]).toBe(job.value!.id);
    expect(mocks.health).toHaveBeenCalledWith(
      'http://127.0.0.1:55444',
      expect.any(AbortSignal),
      true
    );
    flow.open();
    expect(flow.canConfirm.value).toBe(true);
    await flow.confirm();
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      job.value!.id,
      {
        reviewDigest: 'a'.repeat(64),
        confirmedPreviousCycleEnded: true
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(mocks.paymentConfirm).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalledOnce();
    expect(flow.message.value).toContain('后续仍须');
  });
  it.each([
    [false, false],
    [false, true],
    [true, false]
  ])('API=%s、助手=%s不同时支持时不显示人工入口、不额外确认', async (apiReady, helperReady) => {
    scope.stop();
    api = ref(apiReady);
    mocks.health.mockResolvedValue({
      capabilities: helperReady ? ['next-subscription-cycle-v1'] : []
    });
    scope = effectScope();
    flow = scope.run(() => useRechargeNextCycle(job, api, refreshed))!;
    if (apiReady) await vi.waitFor(() => expect(flow.capabilityQuery.phase.value).toBe('ready'));
    flow.open();
    await flow.confirm();
    expect(flow.canOpen.value).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each(['ready', 'consumed', 'revoked'] as const)('自动%s状态不增加人工步骤', async (status) => {
    job.value = {
      ...makeJob(),
      result: { ...makeJob().result, cycle_review: { ...makeJob().result.cycle_review!, status } }
    };
    expect(flow.candidate.value).toBe(false);
    flow.open();
    await flow.confirm();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('旧协议、普通充值和已经发出付款的任务不显示人工入口', async () => {
    await ready();
    job.value = { ...makeJob(), result: { mode: 'payment', account_matched: true } };
    expect(flow.canOpen.value).toBe(false);
    job.value = {
      ...makeJob(),
      result: { ...makeJob().result, payment_attempted: true, payment_requests_sent: 1 }
    };
    expect(flow.canOpen.value).toBe(false);
    flow.open();
    await flow.confirm();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('过期后按钮失效，即使已经打开弹窗也不能发送确认', async () => {
    await ready();
    vi.useFakeTimers();
    job.value = {
      ...makeJob(),
      result: {
        ...makeJob().result,
        cycle_review: {
          ...makeJob().result.cycle_review!,
          expiresAt: new Date(Date.now() + 100).toISOString()
        }
      }
    };
    await vi.advanceTimersByTimeAsync(0);
    flow.open();
    await vi.advanceTimersByTimeAsync(101);
    expect(flow.canOpen.value).toBe(false);
    await flow.confirm();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('双击及核实回包丢失后不重发，同一摘要状态来回变化也不再次授权核实', async () => {
    await ready();
    let reject!: (cause: unknown) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)));
    flow.open();
    const first = flow.confirm();
    await flow.confirm();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    reject(new Error('fixture-lost-response'));
    await first;
    job.value = {
      ...makeJob(),
      result: {
        ...makeJob().result,
        cycle_review: { ...makeJob().result.cycle_review!, status: 'ready' }
      }
    };
    job.value = makeJob();
    await vi.waitFor(() => expect(flow.capabilityQuery.phase.value).toBe('ready'));
    flow.open();
    await flow.confirm();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(flow.message.value).toContain('不会重复');
  });
  it('人工核实等待中切换身份丢弃旧UI回执，不重发且原任务必须重新从本人列表读取', async () => {
    await ready();
    let resolve!: (value: unknown) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((accept) => (resolve = accept)));
    flow.open();
    const first = flow.confirm();
    const signal = mocks.confirm.mock.calls[0]?.[2].signal as AbortSignal;
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    expect(signal.aborted).toBe(true);
    expect(flow.canOpen.value).toBe(false);
    expect(flow.dialogOpen.value).toBe(false);
    expect(flow.busy.value).toBe(false);
    resolve({ cycleReview: { ...makeJob().result.cycle_review, status: 'ready' } });
    await first;
    expect(refreshed).not.toHaveBeenCalled();
    expect(flow.message.value).toBe('');
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });
  it('原连接读取迟到且身份已变化时不访问旧员工助手', async () => {
    scope.stop();
    let resolve!: (value: unknown) => void;
    mocks.access.mockImplementationOnce(() => new Promise((accept) => (resolve = accept)));
    mocks.health.mockClear();
    scope = effectScope();
    flow = scope.run(() => useRechargeNextCycle(job, api, refreshed))!;
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    resolve({ connectorUrl: 'http://127.0.0.1:55444', connectorToken: 'fixture-old-token' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(flow.canOpen.value).toBe(false);
  });
});
