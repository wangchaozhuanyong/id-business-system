import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeJob } from './contracts';
import { useRechargeLocalConfirmation } from './useRechargeLocalConfirmation';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

const mocks = vi.hoisted(() => ({ access: vi.fn(), status: vi.fn(), confirm: vi.fn() }));
vi.mock('./api', () => ({
  rechargeApi: { bitBrowserAccess: mocks.access },
  rechargeConnectorApi: { status: mocks.status, confirm: mocks.confirm }
}));
const quote = {
  plan: 'plus' as const,
  today: { currency: 'PHP', amount: '1000', amount_minor: 100000 },
  tax: null,
  renewal: { currency: 'PHP', amount: '1200', amount_minor: 120000 },
  renewal_interval: 'monthly'
};
const makeJob = (): V2RechargeJob => ({
  id: 'fixture-job',
  action: 'bitbrowser',
  state: 'awaiting_confirmation',
  plan: 'plus',
  result: {
    quote,
    quote_digest: 'fixture-quote-digest',
    account_matched: true,
    operation: 'subscription_upgrade',
    quote_authority: 'official_upgrade_preview',
    current_plan_before: 'go'
  },
  createdAt: '',
  updatedAt: ''
});
const localState = () => ({
  ok: true,
  status: 'awaiting_confirmation',
  result: {
    status: 'awaiting_confirmation',
    nonce: 'synthetic-one-time-nonce',
    quote_digest: 'fixture-quote-digest',
    confirmation_expires_at: new Date(Date.now() + 60_000).toISOString(),
    quote
  }
});
let scope = effectScope();
let job = ref<V2RechargeJob | undefined>();
let confirmation: ReturnType<typeof useRechargeLocalConfirmation>;
const refresh = vi.fn();
beforeEach(() => {
  clearV2SessionDrafts();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.access.mockResolvedValue({
    connectorUrl: 'http://127.0.0.1:55322',
    connectorToken: 'synthetic-key'
  });
  mocks.status.mockImplementation(async () => localState());
  mocks.confirm.mockResolvedValue({ ok: true });
  job = ref(makeJob());
  scope = effectScope();
  confirmation = scope.run(() => useRechargeLocalConfirmation(job, refresh))!;
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('本机单次报价确认', () => {
  it('后台不含 nonce，必须由原本机助手取回相同报价摘要后才能确认', async () => {
    expect(job.value?.result.nonce).toBeUndefined();
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    expect(mocks.status).toHaveBeenCalledWith(
      'http://127.0.0.1:55322',
      'synthetic-key',
      'fixture-job'
    );
    await confirmation.confirm();
    expect(mocks.confirm).toHaveBeenCalledWith(
      'http://127.0.0.1:55322',
      'synthetic-key',
      'fixture-job',
      'synthetic-one-time-nonce',
      'fixture-quote-digest'
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(job.value?.result.nonce).toBeUndefined();
  });
  it('重复点击只发送一次确认，请求后不恢复已消费的 nonce', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    await Promise.all([confirmation.confirm(), confirmation.confirm()]);
    await confirmation.readConfirmation();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(confirmation.confirmationEnabled.value).toBe(false);
  });
  it('确认响应丢失后保持待核验，不自动重发', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    mocks.confirm.mockRejectedValueOnce(new Error('synthetic lost response'));
    await confirmation.confirm();
    await confirmation.confirm();
    await confirmation.readConfirmation();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(confirmation.message.value).toContain('不会重复');
  });
  it('确认前连接读取失败不消费确认凭据，明确未发送并允许刷新后重试', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    mocks.access.mockRejectedValueOnce(new Error('fixture-access-read-failed'));
    await confirmation.confirm();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(confirmation.message.value).toContain('尚未发送付款确认');
    expect(confirmation.busy.value).toBe(false);
    await confirmation.readConfirmation();
    expect(confirmation.confirmationEnabled.value).toBe(true);
    await confirmation.confirm();
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });
  it('已发送任务的状态或报价回跳，以及切换记录返回，均不恢复再次确认资格', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    mocks.confirm.mockRejectedValueOnce(new Error('fixture-lost-response'));
    await confirmation.confirm();
    job.value = { ...makeJob(), state: 'confirming' };
    job.value = {
      ...makeJob(),
      result: { ...makeJob().result, quote_digest: 'fixture-other-digest' }
    };
    job.value = makeJob();
    job.value = undefined;
    job.value = makeJob();
    await nextTick();
    await confirmation.confirm();
    await confirmation.readConfirmation();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(confirmation.message.value).toContain('不会重复');
  });
  it('连接信息读取后再次核验账号、报价和付款计数，不能发送过时授权', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    let release!: (value: { connectorUrl: string; connectorToken: string }) => void;
    mocks.access.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = confirmation.confirm();
    job.value = {
      ...makeJob(),
      result: { ...makeJob().result, account_matched: false, confirmation_requests_sent: 1 }
    };
    release({ connectorUrl: 'http://127.0.0.1:55322', connectorToken: 'fixture-token' });
    await pending;
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(confirmation.busy.value).toBe(false);
  });
  it('身份切换时废弃读取中的原员工连接，迟到结果不得向旧任务确认', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    let release!: (value: { connectorUrl: string; connectorToken: string }) => void;
    mocks.access.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = confirmation.confirm();
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    release({ connectorUrl: 'http://127.0.0.1:55444', connectorToken: 'fixture-other-employee' });
    await pending;
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('必须使用原任务最新取回的连接快照，不能沿用其他员工配置', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    mocks.access.mockResolvedValueOnce({
      connectorUrl: 'http://127.0.0.1:55444',
      connectorToken: 'fixture-job-owner-token'
    });
    await confirmation.confirm();
    expect(mocks.confirm.mock.calls[0]?.slice(0, 3)).toEqual([
      'http://127.0.0.1:55444',
      'fixture-job-owner-token',
      'fixture-job'
    ]);
  });
  it('本机摘要不符或确认已过期时不能开启付款按钮', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    job.value = { ...makeJob(), result: { ...makeJob().result, quote_digest: 'changed-digest' } };
    await vi.waitFor(() => expect(confirmation.message.value).toContain('状态已变化'));
    expect(confirmation.confirmationEnabled.value).toBe(false);
    mocks.status.mockImplementation(async () => ({
      ...localState(),
      result: {
        ...localState().result,
        quote_digest: 'changed-digest',
        confirmation_expires_at: new Date(Date.now() - 1000).toISOString()
      }
    }));
    await confirmation.readConfirmation();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('报价自然到期时立即禁用确认，不需要点击或刷新，也不发送付款请求', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    const remaining = Date.parse(confirmation.expiresAt.value) - Date.now();
    await vi.advanceTimersByTimeAsync(remaining - 1);
    expect(confirmation.confirmationEnabled.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toContain('报价确认已过期');
    expect(confirmation.message.value).toContain('尚未发送付款确认');
    await confirmation.confirm();
    expect(mocks.access).toHaveBeenCalledOnce();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('读取连接配置期间报价自然到期，迟到配置不能发送确认', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    let release!: (value: { connectorUrl: string; connectorToken: string }) => void;
    mocks.access.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = confirmation.confirm();
    await vi.advanceTimersByTimeAsync(Date.parse(confirmation.expiresAt.value) - Date.now());
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toContain('尚未发送付款确认');
    release({ connectorUrl: 'http://127.0.0.1:55322', connectorToken: 'fixture-token' });
    await pending;
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(confirmation.busy.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('后台计时器未执行时，点击与连接配置返回仍按绝对期限拒绝确认', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    vi.setSystemTime(Date.parse(confirmation.expiresAt.value));
    await confirmation.confirm();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toContain('报价确认已过期');
    expect(mocks.access).toHaveBeenCalledOnce();
    expect(mocks.confirm).not.toHaveBeenCalled();
    await confirmation.readConfirmation();
    expect(confirmation.confirmationEnabled.value).toBe(true);
    let release!: (value: { connectorUrl: string; connectorToken: string }) => void;
    mocks.access.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = confirmation.confirm();
    vi.setSystemTime(Date.parse(confirmation.expiresAt.value));
    release({ connectorUrl: 'http://127.0.0.1:55322', connectorToken: 'fixture-token' });
    await pending;
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toContain('尚未发送付款确认');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('同一任务重新读取凭据后，旧到期回调不能清除新的确认资格', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await confirmation.readConfirmation();
    const oldCallback = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof oldCallback).toBe('function');
    const oldExpiry = confirmation.expiresAt.value;
    mocks.status.mockImplementationOnce(async () => ({
      ...localState(),
      result: {
        ...localState().result,
        nonce: 'synthetic-new-nonce',
        confirmation_expires_at: new Date(Date.now() + 120_000).toISOString()
      }
    }));
    await confirmation.readConfirmation();
    vi.setSystemTime(Date.parse(oldExpiry));
    (oldCallback as () => void)();
    expect(confirmation.confirmationEnabled.value).toBe(true);
    expect(confirmation.message.value).toBe('');
    await confirmation.confirm();
    expect(mocks.confirm.mock.calls[0]?.[3]).toBe('synthetic-new-nonce');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('切换任务和报价后，旧到期回调不能影响新任务', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await confirmation.readConfirmation();
    const oldCallback = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof oldCallback).toBe('function');
    const oldExpiry = confirmation.expiresAt.value;
    mocks.status.mockImplementationOnce(async () => ({
      ...localState(),
      result: {
        ...localState().result,
        quote_digest: 'new-job-digest',
        confirmation_expires_at: new Date(Date.now() + 120_000).toISOString()
      }
    }));
    job.value = {
      ...makeJob(),
      id: 'new-job',
      result: { ...makeJob().result, quote_digest: 'new-job-digest' }
    };
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    vi.setSystemTime(Date.parse(oldExpiry));
    (oldCallback as () => void)();
    expect(confirmation.confirmationEnabled.value).toBe(true);
    expect(confirmation.message.value).toBe('');
    await confirmation.confirm();
    expect(mocks.confirm.mock.calls[0]?.[2]).toBe('new-job');
    expect(mocks.confirm.mock.calls[0]?.[4]).toBe('new-job-digest');
  });
  it('切换身份清理旧计时器，旧回调不能修改新身份的确认状态', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await confirmation.readConfirmation();
    const oldCallback = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof oldCallback).toBe('function');
    mocks.access.mockImplementationOnce(() => new Promise(() => {}));
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    expect(vi.getTimerCount()).toBe(0);
    (oldCallback as () => void)();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toBe('');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('离开页面时清理计时器，迟到回调不能写入已销毁的组件', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await confirmation.readConfirmation();
    const oldCallback = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof oldCallback).toBe('function');
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    (oldCallback as () => void)();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toBe('');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('后台标签页计时器延迟，返回前台时立即校正过期状态并清理监听', async () => {
    scope.stop();
    const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    const removeListener = vi.spyOn(page, 'removeEventListener');
    vi.stubGlobal('document', page);
    scope = effectScope();
    confirmation = scope.run(() => useRechargeLocalConfirmation(job, refresh))!;
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    vi.setSystemTime(Date.parse(confirmation.expiresAt.value));
    page.dispatchEvent(new Event('visibilitychange'));
    expect(confirmation.confirmationEnabled.value).toBe(true);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(confirmation.message.value).toContain('报价确认已过期');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
    scope.stop();
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('已开始付款、历史服务器任务或其他账号任务不能沿用本次确认', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    job.value = { ...makeJob(), action: 'server' };
    await nextTick();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    await confirmation.confirm();
    job.value = { ...makeJob(), state: 'confirming' };
    expect(confirmation.confirmationEnabled.value).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each([
    { account_matched: false },
    { quote_authority: undefined },
    { quote: { ...quote, plan: 'go' } },
    { payment_attempted: true },
    { payment_requests_sent: 1 },
    { confirmation_requests_sent: 1 }
  ] as V2RechargeJob['result'][])(
    '缺少账号/官网报价证明或已提交请求不能授权付款 %j',
    async (result) => {
      await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
      job.value = { ...makeJob(), result: { ...makeJob().result, ...result } };
      expect(confirmation.confirmationEnabled.value).toBe(false);
      await confirmation.confirm();
      expect(mocks.confirm).not.toHaveBeenCalled();
    }
  );
  it('迟到的旧任务确认读取不能覆盖新任务', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    let release: (value: ReturnType<typeof localState>) => void = () => {};
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    job.value = { ...makeJob(), id: 'other-job' };
    await nextTick();
    job.value = undefined;
    release(localState());
    await nextTick();
    expect(confirmation.confirmationEnabled.value).toBe(false);
    await confirmation.confirm();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('确认前取用连接权限期间切换任务或离开页面，不向旧任务发送迟到确认', async () => {
    await vi.waitFor(() => expect(confirmation.confirmationEnabled.value).toBe(true));
    let release: (value: { connectorUrl: string; connectorToken: string }) => void = () => {};
    mocks.access.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const sending = confirmation.confirm();
    job.value = undefined;
    release({ connectorUrl: 'http://127.0.0.1:55322', connectorToken: 'synthetic-key' });
    await sending;
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
