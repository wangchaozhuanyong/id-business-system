import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRechargeVoice, type RechargeVoiceState } from './rechargeVoice';
import type { OnlinePlan, OnlineRechargeVoicePage } from './contracts';

const event = (taskId: string, plan: OnlinePlan = 'plus', at = '2026-10-18T00:00:01.000Z') => ({
  id: `event-${taskId}`,
  taskId,
  plan,
  createdAt: at
});
const page = (cursor: string, items: OnlineRechargeVoicePage['items'] = [], hasMore = false) => ({
  cursor,
  items,
  hasMore
});
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
const cleanup: (() => void)[] = [];
function fixture(acquired = true) {
  let refresh = () => {};
  let allowed = true;
  const state: RechargeVoiceState = { status: 'off', message: '', error: false };
  const read = vi.fn<(cursor: string, signal: AbortSignal) => Promise<OnlineRechargeVoicePage>>();
  read.mockResolvedValue(page('initial'));
  const speak = vi.fn<(text: string, onError: () => void) => void>();
  const cancel = vi.fn();
  const unsubscribe = vi.fn();
  const withLock = vi.fn(async (work: (acquired: boolean) => Promise<void>) => work(acquired));
  const voice = createRechargeVoice({
    allowed: () => allowed,
    read,
    withLock,
    speak,
    cancel,
    subscribe(callback) {
      refresh = callback;
      return unsubscribe;
    },
    update: (next) => Object.assign(state, next)
  });
  cleanup.push(voice.stop);
  return {
    voice,
    state,
    read,
    speak,
    cancel,
    unsubscribe,
    withLock,
    refresh: () => refresh(),
    disallow: () => (allowed = false)
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe('新充值任务语音生命周期', () => {
  it('默认关闭，不能读取订单或自动发声', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(60_000);
    f.voice.test();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.speak).not.toHaveBeenCalled();
  });

  it('无读取权限不能启用，另一个标签页持锁时也不读取或取消该页声音', async () => {
    const denied = fixture();
    denied.disallow();
    denied.voice.enable();
    expect(denied.withLock).not.toHaveBeenCalled();
    const locked = fixture(false);
    locked.voice.enable();
    await flush();
    expect(locked.state.status).toBe('off');
    expect(locked.state.message).toContain('另一个后台标签页');
    expect(locked.read).not.toHaveBeenCalled();
    expect(locked.speak).not.toHaveBeenCalled();
    expect(locked.cancel).not.toHaveBeenCalled();
  });

  it('启用只建立服务器基线，不朗读历史；重复点击仅取得一次锁', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(page('base', [event('history')]));
    f.voice.enable();
    f.voice.enable();
    await flush();
    expect(f.withLock).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0][0]).toBe('baseline');
    expect(f.speak.mock.calls.map(([text]) => text)).toEqual(['充值订单语音播报已开启。']);
    expect(f.state.status).toBe('on');
  });

  it('按四种套餐读人声文案，分页和重叠补读按任务去重', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(page('base'))
      .mockResolvedValueOnce(page('next', [event('one'), event('two', 'pro_5x')], true))
      .mockResolvedValueOnce(
        page('done', [event('two', 'pro_5x'), event('three', 'pro_20x'), event('four', 'pro_500')])
      )
      .mockResolvedValueOnce(page('overlap', [event('one'), event('three', 'pro_20x')]));
    f.voice.enable();
    await flush();
    f.refresh();
    await flush();
    f.refresh();
    await flush();
    expect(f.speak.mock.calls.slice(1).map(([text]) => text)).toEqual([
      '您有新的充值订单，Plus 套餐。',
      '您有新的充值订单，Pro 100 套餐。',
      '您有新的充值订单，Pro 200 套餐。',
      '您有新的充值订单，Pro 500 套餐。'
    ]);
    expect(f.read.mock.calls.map(([cursor]) => cursor)).toEqual([
      'baseline',
      'base',
      'next',
      'done'
    ]);
  });

  it('漏掉实时变化时定时补读，失败保留游标与去重资料', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(page('base'))
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockResolvedValueOnce(page('recovered', [event('recovered')]));
    f.voice.enable();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.state).toMatchObject({ status: 'on', error: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.read.mock.calls.map(([cursor]) => cursor)).toEqual(['baseline', 'base', 'base']);
    expect(f.speak.mock.calls.at(-1)?.[0]).toBe('您有新的充值订单，Plus 套餐。');
    expect(f.state.error).toBe(false);
  });

  it('高频变更与分页串行消费，基线请求中发生变更也会补读', async () => {
    const f = fixture();
    let resolve!: (value: OnlineRechargeVoicePage) => void;
    f.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    f.voice.enable();
    f.refresh();
    f.refresh();
    expect(f.read).toHaveBeenCalledTimes(1);
    f.read.mockResolvedValueOnce(page('new', [event('new')]));
    resolve(page('base'));
    await flush();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.speak.mock.calls.at(-1)?.[0]).toBe('您有新的充值订单，Plus 套餐。');
  });

  it('关闭中断请求、解除监听、取消语音且丢弃旧身份迟到响应', async () => {
    const f = fixture();
    f.voice.enable();
    await flush();
    let resolve!: (value: OnlineRechargeVoicePage) => void;
    f.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    f.refresh();
    const signal = f.read.mock.calls.at(-1)![1];
    f.voice.stop();
    expect(signal.aborted).toBe(true);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    resolve(page('late', [event('late')]));
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.speak).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.state.status).toBe('off');
  });

  it('权限撤销后即使请求已发出，也不朗读返回资料', async () => {
    const f = fixture();
    f.voice.enable();
    await flush();
    let resolve!: (value: OnlineRechargeVoicePage) => void;
    f.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    f.refresh();
    f.disallow();
    resolve(page('late', [event('late')]));
    await flush();
    expect(f.speak).toHaveBeenCalledTimes(1);
  });

  it('语音失败关闭并取消剩余队列，关闭后的延迟错误不能影响新运行', async () => {
    const f = fixture();
    f.voice.enable();
    await flush();
    const oldError = f.speak.mock.calls[0][1];
    oldError();
    expect(f.state).toMatchObject({ status: 'off', error: true });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    f.voice.enable();
    await flush();
    oldError();
    expect(f.state.status).toBe('on');
    f.voice.test();
    expect(f.speak.mock.calls.at(-1)?.[0]).toBe('语音播报测试，Pro 200 套餐。');
  });

  it('基线读取失败释放锁且不发声', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('synthetic denied'));
    f.voice.enable();
    await flush();
    expect(f.state).toMatchObject({ status: 'off', error: true });
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it('取得锁前已关闭，不建立基线或发声', async () => {
    const f = fixture();
    let grant!: () => void;
    f.withLock.mockImplementationOnce(
      (work) => new Promise((resolve) => (grant = () => void work(true).then(resolve)))
    );
    f.voice.enable();
    f.voice.stop();
    grant();
    await flush();
    expect(f.state.status).toBe('off');
    expect(f.read).not.toHaveBeenCalled();
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it('未知套餐和非法时间不朗读，不会阻塞后续合法任务', async () => {
    const f = fixture();
    f.voice.enable();
    await flush();
    f.read.mockResolvedValueOnce(
      page('next', [
        { ...event('bad'), plan: 'unknown' as OnlinePlan },
        event('bad-date', 'plus', 'not-a-date'),
        event('good', 'pro_20x')
      ])
    );
    f.refresh();
    await flush();
    expect(f.speak.mock.calls.slice(1).map(([text]) => text)).toEqual([
      '您有新的充值订单，Pro 200 套餐。'
    ]);
  });

  it('重复分页游标作为读取失败处理，避免无休止请求', async () => {
    const f = fixture();
    f.voice.enable();
    await flush();
    f.read.mockResolvedValueOnce(page('initial', [event('bad')], true));
    f.refresh();
    await flush();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.state).toMatchObject({ status: 'on', error: true });
    expect(f.speak).toHaveBeenCalledTimes(1);
  });
});
