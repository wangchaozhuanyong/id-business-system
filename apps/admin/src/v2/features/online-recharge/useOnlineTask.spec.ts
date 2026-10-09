import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { PublicTask } from './contracts';
const api = vi.hoisted(() => ({ publicSubscribe: vi.fn(), task: vi.fn(), action: vi.fn() }));
vi.mock('./api', () => ({ onlineApi: api }));
import { useOnlineTask } from './useOnlineTask';
class FakeSocket {
  static sockets: FakeSocket[] = [];
  readonly sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.onclose?.();
  }
}
async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}
describe('线上代充实时任务边界', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.sockets = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    api.publicSubscribe.mockResolvedValue({
      ticket: 'one-time-ticket',
      wsPath: '/api/id-business-v2/online-recharge/ws'
    });
    api.task.mockResolvedValue({ id: 'task-1', status: 'running', progress: 30 });
    api.action.mockResolvedValue({
      ticket: 'admin-ticket',
      wsPath: '/api/id-business-v2/online-recharge/ws'
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('票据只在订阅首帧传递，正常进度更新不重建连接', async () => {
    const scope = effectScope();
    const task = ref<PublicTask>({ id: 'task-1', status: 'running' });
    scope.run(() => useOnlineTask(task, ref('private-capability')));
    await flush();
    const socket = FakeSocket.sockets[0];
    expect(socket.url).not.toContain('ticket');
    expect(socket.url).not.toContain('private-capability');
    socket.onopen?.();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'subscribe', ticket: 'one-time-ticket' })]);
    socket.onmessage?.({
      data: JSON.stringify({ task: { id: 'task-1', status: 'running', progress: 20 } })
    });
    await flush();
    expect(task.value.progress).toBe(20);
    expect(api.publicSubscribe).toHaveBeenCalledTimes(1);
    scope.stop();
  });
  it('断线只查询已有任务，不重复提交充值', async () => {
    const scope = effectScope();
    const task = ref<PublicTask>({ id: 'task-1', status: 'running' });
    scope.run(() => useOnlineTask(task, ref('private-capability')));
    await flush();
    FakeSocket.sockets[0].onerror?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.task).toHaveBeenCalledWith('task-1', 'private-capability', expect.any(AbortSignal));
    expect(task.value.progress).toBe(30);
    expect(api.publicSubscribe).toHaveBeenCalledTimes(1);
    scope.stop();
  });
  it('身份凭证切换后拒绝旧连接迟到的同任务事件', async () => {
    const scope = effectScope();
    const task = ref<PublicTask>({ id: 'task-1', status: 'running', progress: 1 });
    const token = ref('old');
    scope.run(() => useOnlineTask(task, token));
    await flush();
    const oldSocket = FakeSocket.sockets[0];
    token.value = 'new';
    await flush();
    oldSocket.onmessage?.({
      data: JSON.stringify({ id: 'task-1', status: 'succeeded', progress: 100 })
    });
    expect(task.value.status).toBe('running');
    expect(task.value.progress).toBe(1);
    scope.stop();
  });
  it('页面关闭取消轮询并忽略迟到事件', async () => {
    const scope = effectScope();
    const task = ref<PublicTask>({ id: 'task-1', status: 'running' });
    scope.run(() => useOnlineTask(task, ref('private-capability')));
    await flush();
    const socket = FakeSocket.sockets[0];
    scope.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.task).not.toHaveBeenCalled();
    socket.onmessage?.({ data: JSON.stringify({ id: 'task-1', status: 'succeeded' }) });
    expect(task.value.status).toBe('running');
  });
});
