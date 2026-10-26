import { effectScope, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useRechargeCardCvc } from './useRechargeCardCvc';

const read = vi.hoisted(() => vi.fn());
vi.mock('./bank-recharge-api', () => ({ bankRechargeApi: { sharedCardCvc: read } }));
const create = () => {
  const scope = effectScope();
  const details = ref({ cvc: '' });
  const card = ref('card-a');
  const plan = ref('plus');
  const cvc = scope.run(() => useRechargeCardCvc(details, card, plan))!;
  return { details, card, plan, cvc, stop: () => scope.stop() };
};
const available = () => ({
  cvc: '123',
  expiresAt: new Date(Date.now() + 1000).toISOString(),
  state: 'available'
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('比特选卡临时安全码回填', () => {
  it('回填有效安全码，到期自动清除，不改变卡片选择', async () => {
    const f = create();
    read.mockResolvedValue(available());
    await f.cvc.load('card-a', 'plus', () => true);
    expect(f.details.value.cvc).toBe('123');
    expect(f.cvc.message.value).toContain('已自动填写');
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.details.value.cvc).toBe('');
    expect(f.card.value).toBe('card-a');
    expect(f.cvc.message.value).toContain('已到期');
    f.stop();
  });
  it.each(['busy', 'unavailable'])(
    '没有可用安全码（%s）时保留选卡并说明手动填写',
    async (state) => {
      const f = create();
      read.mockResolvedValue({ state, cvc: null, expiresAt: null });
      await f.cvc.load('card-a', 'plus', () => true);
      expect(f.details.value.cvc).toBe('');
      expect(f.card.value).toBe('card-a');
      expect(f.cvc.message.value).toContain('手动填写');
      f.stop();
    }
  );
  it('已过期返回值不得进入表单', async () => {
    const f = create();
    read.mockResolvedValue({ ...available(), expiresAt: new Date(Date.now() - 1).toISOString() });
    await f.cvc.load('card-a', 'plus', () => true);
    expect(f.details.value.cvc).toBe('');
    f.stop();
  });
  it.each(['card', 'plan', 'identity', 'disposed', 'manual'])(
    '读取期间发生 %s 变化时丢弃迟到安全码',
    async (change) => {
      const f = create();
      let resolve!: (value: ReturnType<typeof available>) => void;
      read.mockImplementation(() => new Promise((done) => (resolve = done)));
      const pending = f.cvc.load('card-a', 'plus', () => true);
      if (change === 'card') f.card.value = 'card-b';
      if (change === 'plan') f.plan.value = 'pro-5x';
      if (change === 'identity')
        sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
      if (change === 'disposed') f.stop();
      if (change === 'manual') f.details.value.cvc = '456';
      resolve(available());
      await pending;
      expect(f.details.value.cvc).toBe(change === 'manual' ? '456' : '');
      f.stop();
    }
  );
  it('用户手动替换后旧到期计时不能清除新输入', async () => {
    const f = create();
    read.mockResolvedValue(available());
    await f.cvc.load('card-a', 'plus', () => true);
    f.details.value.cvc = '456';
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.details.value.cvc).toBe('456');
    f.stop();
  });
  it('页面进入处理中仍按绝对期限清除已回填安全码', async () => {
    const f = create();
    let ready = true;
    read.mockResolvedValue(available());
    await f.cvc.load('card-a', 'plus', () => ready);
    ready = false;
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.details.value.cvc).toBe('');
    f.stop();
  });
  it('临时通道失败不阻断选卡，也不显示原始错误正文', async () => {
    const f = create();
    read.mockRejectedValue(new Error('upstream private data'));
    await f.cvc.load('card-a', 'plus', () => true);
    expect(f.card.value).toBe('card-a');
    expect(f.cvc.message.value).toContain('手动填写');
    expect(f.cvc.message.value).not.toContain('upstream');
    f.stop();
  });
});
