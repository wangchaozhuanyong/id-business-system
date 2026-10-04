import { computed, effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useRechargeHandoff } from './useRechargeHandoff';
import { useRechargeServerConfirmation } from './useRechargeServerConfirmation';
import type { V2RechargeHandoffFrame, V2RechargeJob } from './contracts';

const mock = vi.hoisted(() => ({
  frame: vi.fn(),
  command: vi.fn(),
  confirm: vi.fn(),
  cached: [] as unknown[]
}));
vi.mock('./api', () => ({
  rechargeApi: {
    handoffFrame: mock.frame,
    handoffCommand: mock.command,
    confirmServer: mock.confirm
  }
}));
vi.mock('@/auth/sessionCoordinator', () => ({ sessionCoordinator: { identityEpoch: ref(0) } }));
vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: (options: {
    query: (context: { signal: AbortSignal }) => Promise<number>;
    enabled: () => boolean;
  }) => {
    const phase = ref('idle');
    const error = ref<unknown>();
    let controller: AbortController;
    let hasData = false;
    async function read() {
      if (!options.enabled()) return;
      phase.value = hasData ? 'refreshing' : 'initial-loading';
      controller = new AbortController();
      try {
        const value = await options.query({ signal: controller.signal });
        if (controller.signal.aborted) return;
        mock.cached.push(value);
        hasData = true;
        error.value = undefined;
        phase.value = 'ready';
        return value;
      } catch (cause) {
        error.value = cause;
        phase.value = hasData ? 'refresh-error' : 'initial-error';
      }
    }
    return {
      phase,
      error,
      enabled: computed(options.enabled),
      refresh: read,
      ensureFresh: read,
      cancel: () => {
        controller?.abort();
        phase.value = 'disabled';
      }
    };
  }
}));
const id = '33333333-3333-4333-8333-333333333333';
function syntheticFrame(revision = 1): V2RechargeHandoffFrame {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    frameId: `22222222-2222-4222-8222-${String(revision).padStart(12, '0')}`,
    revision,
    kind: 'bank',
    image: 'data:image/jpeg;base64,AAAA',
    width: 1000,
    height: 600,
    expiresAt: new Date(Date.now() + 100_000).toISOString()
  };
}
function syntheticJob(): V2RechargeJob {
  return {
    id,
    action: 'server',
    plan: 'plus',
    state: 'awaiting_human_verification',
    createdAt: '',
    updatedAt: '',
    result: {
      stage: 'human_verification_ready',
      handoff_available: true,
      handoff_session_id: '11111111-1111-4111-8111-111111111111',
      handoff_generation: 1,
      handoff_kind: 'bank',
      handoff_expires_at: new Date(Date.now() + 300_000).toISOString()
    }
  };
}
let scope = effectScope();
const job = ref<V2RechargeJob | undefined>();
const allowed = ref(true);
let handoff: ReturnType<typeof useRechargeHandoff>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
  vi.clearAllMocks();
  mock.cached = [];
  mock.frame.mockResolvedValue(syntheticFrame());
  mock.command.mockImplementation(async (_id, command) => ({
    commandId: command.commandId,
    accepted: true
  }));
  allowed.value = true;
  job.value = syntheticJob();
  scope = effectScope();
  handoff = scope.run(() => useRechargeHandoff(job, allowed))!;
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});
describe('原窗口临时接管', () => {
  it('缓存只有修订号；刷新保留图像并锁住操作，成功后恢复', async () => {
    await handoff.show();
    handoff.verificationInput.value = '123456';
    let finish!: (frame: V2RechargeHandoffFrame) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const reading = handoff.refreshFrame();
    expect(handoff.frame.value?.image).toContain('data:image/jpeg');
    expect(handoff.verificationInput.value).toBe('');
    expect(handoff.canOperate.value).toBe(false);
    finish(syntheticFrame(2));
    await reading;
    expect(handoff.canOperate.value).toBe(true);
    expect(mock.cached).toEqual([1, 2]);
  });
  it('指令只发送一次；异常锁住且不自动重试，读取新画面后才恢复', async () => {
    await handoff.show();
    mock.command.mockRejectedValueOnce(new Error('unknown'));
    await handoff.send({ type: 'text', text: '123456' });
    expect(mock.command).toHaveBeenCalledTimes(1);
    expect(mock.frame).toHaveBeenCalledTimes(2);
    expect(handoff.canOperate.value).toBe(false);
    expect(handoff.message.value).toContain('结果待核验');
    await handoff.send({ type: 'key', key: 'Enter' });
    expect(mock.command).toHaveBeenCalledTimes(1);
    mock.frame.mockResolvedValueOnce(syntheticFrame(2));
    await handoff.refreshFrame();
    expect(handoff.canOperate.value).toBe(true);
  });
  it('并发点击只接受一个命令，成功后只读取画面', async () => {
    await handoff.show();
    let finish!: (value: unknown) => void;
    mock.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = handoff.send({ type: 'click', x: 250, y: 300 });
    await handoff.send({ type: 'click', x: 250, y: 300 });
    expect(mock.command).toHaveBeenCalledTimes(1);
    finish({ commandId: mock.command.mock.calls[0]![1].commandId, accepted: true });
    await pending;
    expect(mock.frame).toHaveBeenCalledTimes(2);
    expect(mock.confirm).not.toHaveBeenCalled();
  });
  it.each([
    'close',
    'task',
    'permission',
    'identity',
    'kind',
    'session',
    'generation',
    'expiry',
    'cancel'
  ])('%s 立即清除原画面和临时输入，迟到读取不能回填', async (change) => {
    await handoff.show();
    handoff.verificationInput.value = '123456';
    let finish!: (frame: V2RechargeHandoffFrame) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const reading = handoff.refreshFrame();
    handoff.verificationInput.value = '123456';
    if (change === 'close') handoff.close();
    if (change === 'task')
      job.value = { ...syntheticJob(), id: '44444444-4444-4444-8444-444444444444' };
    if (change === 'permission') allowed.value = false;
    if (change === 'identity') (sessionCoordinator.identityEpoch as { value: number }).value += 1;
    if (change === 'kind') job.value!.result.handoff_kind = 'hcaptcha';
    if (change === 'session')
      job.value!.result.handoff_session_id = '55555555-5555-4555-8555-555555555555';
    if (change === 'generation') job.value!.result.handoff_generation = 2;
    if (change === 'expiry')
      job.value!.result.handoff_expires_at = new Date(Date.now() + 90_000).toISOString();
    if (change === 'cancel') job.value!.state = 'finished';
    expect(handoff.frame.value).toBeUndefined();
    expect(handoff.verificationInput.value).toBe('');
    finish(syntheticFrame(2));
    await reading;
    await nextTick();
    expect(handoff.frame.value).toBeUndefined();
  });
  it('关闭后的迟到指令回执不能刷新或复原画面', async () => {
    await handoff.show();
    let finish!: (value: unknown) => void;
    mock.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = handoff.send({ type: 'key', key: 'Enter' });
    handoff.close();
    finish({ commandId: mock.command.mock.calls[0]![1].commandId, accepted: true });
    await pending;
    expect(mock.frame).toHaveBeenCalledTimes(1);
    expect(handoff.frame.value).toBeUndefined();
  });
  it('过期立即清除；旧修订、不同会话或相同修订的不同画面不能覆盖成功内容', async () => {
    mock.frame.mockResolvedValueOnce(syntheticFrame(2));
    await handoff.show();
    for (const invalid of [
      syntheticFrame(1),
      { ...syntheticFrame(2), sessionId: id },
      { ...syntheticFrame(2), frameId: id }
    ]) {
      mock.frame.mockResolvedValueOnce(invalid);
      await handoff.refreshFrame();
      expect(handoff.frame.value?.revision).toBe(2);
      expect(handoff.canOperate.value).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(100_001);
    expect(handoff.frame.value).toBeUndefined();
    expect(handoff.open.value).toBe(false);
  });
  it('权限未确认或任务不在验证状态时不读取、不发指令', async () => {
    allowed.value = false;
    await handoff.show();
    expect(mock.frame).not.toHaveBeenCalled();
    allowed.value = true;
    job.value!.state = 'running';
    await handoff.show();
    await handoff.send({ type: 'key', key: 'Enter' });
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('合法新会话先清除旧画面，再由本人重新打开；画面期限不能延长原会话预算', async () => {
    await handoff.show();
    const nextSession = '55555555-5555-4555-8555-555555555555';
    job.value!.result.handoff_session_id = nextSession;
    job.value!.result.handoff_generation = 2;
    expect(handoff.frame.value).toBeUndefined();
    mock.frame.mockResolvedValueOnce({ ...syntheticFrame(), sessionId: nextSession });
    await handoff.show();
    expect(handoff.frame.value?.sessionId).toBe(nextSession);
    mock.frame.mockResolvedValueOnce({
      ...syntheticFrame(2),
      sessionId: nextSession,
      expiresAt: new Date(Date.now() + 300_001).toISOString()
    });
    await handoff.refreshFrame();
    expect(handoff.frame.value?.revision).toBe(1);
    expect(handoff.canOperate.value).toBe(false);
    job.value!.result.handoff_expires_at = new Date(Date.now() - 1).toISOString();
    const reads = mock.frame.mock.calls.length;
    await handoff.show();
    expect(mock.frame).toHaveBeenCalledTimes(reads);
    expect(handoff.message.value).toContain('超时');
  });
});
describe('服务器报价人工确认', () => {
  const refresh = vi.fn();
  function confirmation() {
    job.value = {
      ...syntheticJob(),
      state: 'awaiting_confirmation',
      result: {
        manual_payment_confirmation: true,
        nonce: 'synthetic-quote-nonce',
        quote: {
          plan: 'plus',
          today: { currency: 'PHP', amount: '100.00', amount_minor: 10000 },
          tax: null,
          renewal: null,
          renewal_interval: 'unknown'
        }
      }
    };
    return scope.run(() => useRechargeServerConfirmation(job, allowed, refresh))!;
  }
  it('本人确认当前报价只发送原单和 nonce 一次', async () => {
    const control = confirmation();
    mock.confirm.mockResolvedValue({ id });
    await control.confirm();
    await control.confirm();
    expect(mock.confirm).toHaveBeenCalledExactlyOnceWith(id, 'synthetic-quote-nonce');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('确认结果未知不自动重发；关闭人工确认或缺少报价时不能放行', async () => {
    const control = confirmation();
    mock.confirm.mockRejectedValue(new Error('unknown'));
    await control.confirm();
    await control.confirm();
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    expect(control.message.value).toContain('结果待核验');
    job.value!.result.manual_payment_confirmation = false;
    expect(control.confirmationEnabled.value).toBe(false);
    job.value!.result.nonce = 'new';
    job.value!.result.manual_payment_confirmation = true;
    job.value!.result.quote = undefined;
    expect(control.confirmationEnabled.value).toBe(false);
  });
  it('切换任务后的迟到确认不能刷新新任务', async () => {
    const control = confirmation();
    let finish!: (value: unknown) => void;
    mock.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = control.confirm();
    job.value = { ...job.value!, id: 'new-job' };
    finish({ id });
    await pending;
    expect(refresh).not.toHaveBeenCalled();
    expect(control.busy.value).toBe(false);
  });
});
