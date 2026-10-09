import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import {
  assertHandoffJob,
  requestHandoffWorker,
  validateHandoffCommand,
  validateHandoffFrame
} from './recharge-handoff';
import { confirmationNonce, hash, safeDocument } from './recharge-validation';
import { mergeRechargeCallbackResult } from './recharge-bank-callback';

const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const frameId = '33333333-3333-4333-8333-333333333333';
const commandId = '44444444-4444-4444-8444-444444444444';
const operator = {
  id: 'test-admin',
  username: 'test',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const frame = () => ({
  sessionId,
  frameId,
  revision: 1,
  kind: 'hcaptcha',
  image: 'data:image/jpeg;base64,/9j/AAAA',
  width: 320,
  height: 240,
  expiresAt: new Date(Date.now() + 290000).toISOString()
});
const command = () => ({
  commandId,
  sessionId,
  frameId,
  revision: 1,
  type: 'click',
  x: 80,
  y: 120
});
const money = { amount: '20.00', amount_minor: 2000, currency: 'USD' };
const quote = {
  plan: 'plus' as const,
  today: money,
  tax: { ...money, amount: '0.00', amount_minor: 0 },
  renewal: money,
  renewal_interval: 'monthly'
};
const report = () => ({
  status: 'awaiting_confirmation',
  quote,
  quote_authority: 'official_checkout_response',
  nonce: confirmationNonce(id, quote, 'x'.repeat(64))
});
const makeJob = () => ({
  id,
  ownerId: operator.id,
  action: 'server',
  state: 'awaiting_human_verification',
  plan: 'plus',
  accountKey: null,
  nonceHash: null as string | null,
  leaseUntil: new Date(Date.now() + 600000),
  result: {
    handoff_available: true,
    handoff_kind: 'hcaptcha',
    handoff_session_id: sessionId,
    handoff_generation: 1,
    handoff_expires_at: frame().expiresAt,
    manual_payment_confirmation: true,
    account_matched: true,
    locked_currency: 'USD'
  } as Record<string, unknown>
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  vi.stubEnv('AUTO_RECHARGE_WORKER_TOKEN', 'x'.repeat(64));
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('原窗口验证协议与权限', () => {
  it.each([
    command(),
    { ...command(), type: 'key', key: 'Tab', x: undefined, y: undefined },
    { commandId, sessionId, frameId, revision: 1, type: 'text', text: '123456' },
    { commandId, sessionId, frameId, revision: 1, type: 'scroll', deltaY: -200 }
  ])('只接受受控操作 %j', (value) => {
    const clean = Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined)
    );
    expect(validateHandoffCommand(clean)).toEqual(clean);
  });
  it.each([
    { ...command(), revision: 0 },
    { ...command(), x: -1 },
    { ...command(), sessionId: id + '/other' },
    { ...command(), script: 'window.location.reload()' },
    { commandId, sessionId, frameId, revision: 1, type: 'key', key: 'F5' },
    { commandId, sessionId, frameId, revision: 1, type: 'text', text: 'a'.repeat(65) },
    { commandId, sessionId, frameId, revision: 1, type: 'text', text: '\n' },
    { commandId, sessionId, frameId, revision: 1, type: 'scroll', deltaY: 601 }
  ])('拒绝导航、脚本及越界 %j', (value) => {
    expect(() => validateHandoffCommand(value)).toThrow('验证操作无效');
  });
  it('校验仅本人有效服务器任务且不是原单只读复查', () => {
    const job = makeJob();
    expect(assertHandoffJob(job, operator.id)).toBe(job.result);
    expect(() => assertHandoffJob(job, 'other')).toThrow('无权');
    for (const patch of [
      { state: 'finished' },
      { state: 'unknown' },
      { action: 'bitbrowser' },
      { leaseUntil: new Date(Date.now() - 1) },
      { result: { ...job.result, recheck_only: true } },
      { result: { ...job.result, handoff_available: false } },
      { result: { ...job.result, handoff_expires_at: 'invalid' } }
    ])
      expect(() => assertHandoffJob({ ...job, ...patch }, operator.id)).toThrow('已结束');
  });
  it('画面限定图片格式、尺寸、有效期和字段，不接受远程URL或秘密', () => {
    expect(validateHandoffFrame(frame())).toEqual(frame());
    for (const patch of [
      { image: 'https://bank.example.invalid/challenge' },
      { width: 4096 },
      { expiresAt: new Date(Date.now() - 1).toISOString() },
      { expiresAt: new Date(Date.now() + 600000).toISOString() },
      { token: 'private' }
    ])
      expect(() => validateHandoffFrame({ ...frame(), ...patch })).toThrow();
    expect(
      safeDocument({
        ...frame(),
        image: frame().image,
        text: '123456',
        password: 'private',
        handoff_available: true,
        handoff_kind: 'hcaptcha',
        handoff_session_id: sessionId,
        handoff_generation: 1,
        handoff_expires_at: frame().expiresAt
      })
    ).toEqual({
      handoff_available: true,
      handoff_kind: 'hcaptcha',
      handoff_session_id: sessionId,
      handoff_generation: 1,
      handoff_expires_at: frame().expiresAt
    });
  });
  it('命令失败仅发一次，无通用任务accepted收据回退', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network unknown'));
    await expect(requestHandoffWorker(id, command() as never)).rejects.toThrow('不要重复提交');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('只接受同一命令的回执，错误编号与任务accepted都不能作确认', async () => {
    for (const receipt of [
      { commandId: id, accepted: true },
      { accepted: true },
      { commandId, accepted: false }
    ]) {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(receipt)
      } as never);
      await expect(requestHandoffWorker(id, command() as never)).rejects.toThrow('待核验');
    }
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ commandId, accepted: true })
    } as never);
    await expect(requestHandoffWorker(id, command() as never)).resolves.toEqual({
      commandId,
      accepted: true
    });
  });
});

describe('人工付款确认与当前任务状态', () => {
  function harness() {
    const job = makeJob();
    const repository = {
      lock: vi.fn(),
      owned: vi.fn(async () => job),
      active: vi.fn(async () => job),
      updateJob: vi.fn(async (_tx: unknown, _id: string, data: object) => Object.assign(job, data))
    };
    const audit = { append: vi.fn() };
    const transactions = { execute: vi.fn(async (work: (tx: unknown) => unknown) => work({})) };
    const service = new RechargeService(
      repository as never,
      {} as never,
      transactions as never,
      audit as never
    );
    return { job, repository, audit, service };
  }
  it('读取途中任务结束丢弃旧画面', async () => {
    const { service, job } = harness();
    vi.mocked(fetch).mockImplementation(async () => {
      job.state = 'finished';
      return { ok: true, text: async () => JSON.stringify(frame()) } as never;
    });
    await expect(service.handoffFrame(id, operator)).rejects.toThrow('已结束');
  });
  it('历史服务器确认与接管操作已退役，不再授予远程付款或发送挑战资料', async () => {
    const { service, audit, repository } = harness();
    await expect(service.handoffCommand(id, command(), operator)).rejects.toThrow(
      '服务器远程操作已停用'
    );
    await expect(service.confirm(id, report().nonce, operator)).rejects.toThrow('本机充值助手');
    expect(repository.active).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('服务器报价始终进入人工确认，旧关闭或缺失标记不能触发自动付款', async () => {
    for (const mode of [true, false, undefined]) {
      const { service, job } = harness();
      job.state = 'running';
      if (mode === undefined) delete job.result.manual_payment_confirmation;
      else job.result.manual_payment_confirmation = mode;
      await service.callback(id, { type: 'confirmation', result: report() });
      expect(job.state).toBe('awaiting_confirmation');
      expect(job.result.manual_payment_confirmation).toBe(true);
      expect(job.nonceHash).toBe(hash(report().nonce));
    }
  });
  it('人工模式拒绝旧执行器直接自动确认的回执，不放行付款', async () => {
    const { service, job, audit } = harness();
    job.state = 'running';
    await expect(
      service.callback(id, {
        type: 'confirmation',
        result: { ...report(), status: 'confirming' }
      })
    ).rejects.toThrow('未进入人工确认等待');
    expect(job.state).toBe('running');
    expect(job.nonceHash).toBeNull();
    expect(audit.append).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('等待验证保持已确认事实，退出验证后恢复付款核对；未知状态不能重开窗口', async () => {
    const { service, job } = harness();
    job.state = 'confirming';
    job.result.manual_confirmation_accepted = true;
    const progress = {
      stage: 'human_verification_ready',
      handoff_available: true,
      handoff_kind: 'hcaptcha',
      handoff_session_id: sessionId,
      handoff_generation: 1,
      handoff_expires_at: frame().expiresAt
    };
    await service.callback(id, { type: 'progress', result: progress });
    expect(job.state).toBe('awaiting_human_verification');
    await service.callback(id, {
      type: 'progress',
      result: {
        handoff_available: false,
        handoff_kind: 'hcaptcha',
        handoff_session_id: sessionId,
        handoff_generation: 1,
        handoff_expires_at: frame().expiresAt,
        stage: 'payment_verifying'
      }
    });
    expect(job.state).toBe('confirming');
    job.state = 'unknown';
    await expect(service.callback(id, { type: 'progress', result: progress })).rejects.toThrow(
      '验证窗口'
    );
    expect(job.state).toBe('unknown');
  });
  it('旧官网挑战的结束或恢复回执不能覆盖新银行验证窗口', async () => {
    const { service, job } = harness();
    const old = {
      handoff_kind: 'hcaptcha',
      handoff_expires_at: frame().expiresAt,
      handoff_session_id: sessionId,
      handoff_generation: 1
    };
    const current = {
      handoff_kind: 'bank',
      handoff_session_id: frameId,
      handoff_generation: 2,
      handoff_expires_at: frame().expiresAt
    };
    await service.callback(id, {
      type: 'progress',
      result: { ...current, handoff_available: true }
    });
    for (const available of [false, true])
      await expect(
        service.callback(id, { type: 'progress', result: { ...old, handoff_available: available } })
      ).rejects.toThrow('旧验证窗口');
    expect(job.state).toBe('awaiting_human_verification');
    expect(job.result).toMatchObject({ ...current, handoff_available: true });
  });
  it('新验证代次不能延长原真人与银行验证的总预算', async () => {
    const { service, job } = harness();
    const original = { ...job.result };
    vi.setSystemTime(new Date(Date.now() + 60000));
    await expect(
      service.callback(id, {
        type: 'progress',
        result: {
          handoff_available: true,
          handoff_kind: 'bank',
          handoff_session_id: frameId,
          handoff_generation: 2,
          handoff_expires_at: frame().expiresAt
        }
      })
    ).rejects.toThrow('不能延长原等待时间');
    expect(job.result).toEqual(original);
    expect(job.state).toBe('awaiting_human_verification');
  });
  it('执行器不能取消人工确认或清除确认事实，旧记录也明确转人工模式', () => {
    const job = makeJob();
    job.result.manual_confirmation_accepted = true;
    expect(
      mergeRechargeCallbackResult(job as never, {
        manual_payment_confirmation: false,
        manual_confirmation_accepted: false
      })
    ).toMatchObject({ manual_payment_confirmation: true, manual_confirmation_accepted: true });
    delete job.result.manual_payment_confirmation;
    expect(
      mergeRechargeCallbackResult(job as never, { manual_payment_confirmation: true })
    ).toMatchObject({ manual_payment_confirmation: true });
  });

  it('服务器完整报价超过旧上限仍只等待人工确认，不发付款请求', async () => {
    const { service, job } = harness();
    job.state = 'running';
    job.result.max_amount_minor = 3000;
    const actualQuote = {
      ...quote,
      today: { ...money, amount: '40000.00', amount_minor: 4000000 }
    };
    const nonce = confirmationNonce(id, actualQuote, 'x'.repeat(64));
    await service.callback(id, {
      type: 'confirmation',
      result: { ...report(), quote: actualQuote, nonce }
    });
    expect(job.state).toBe('awaiting_confirmation');
    expect(job.nonceHash).toBe(hash(nonce));
    expect(job.result).toMatchObject({ quote: { today: { amount_minor: 4000000 } } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
