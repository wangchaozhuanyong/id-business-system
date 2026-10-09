import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { onlineApi } from './api';
import type { PublicTask } from './contracts';
import { onlineError } from './labels';
export function useOnlineTask(
  task: Ref<PublicTask | undefined>,
  token: Ref<string>,
  customer = true
) {
  const error = ref('');
  const connected = ref(false);
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let revision = 0;
  const terminal = (status: string) =>
    ['succeeded', 'success', 'failed', 'cancelled'].includes(status);
  function stop() {
    revision++;
    socket?.close();
    socket = undefined;
    connected.value = false;
    if (timer) clearTimeout(timer);
    controller?.abort();
  }
  async function refresh() {
    if (!task.value?.id || (customer && !token.value)) return;
    const current = revision;
    controller?.abort();
    controller = new AbortController();
    try {
      const value = customer
        ? await onlineApi.task(task.value.id, token.value, controller.signal)
        : await onlineApi.action('jobs', 'detail', { id: task.value.id });
      if (current === revision) {
        task.value = value as unknown as PublicTask;
        error.value = '';
      }
    } catch (cause) {
      if (current === revision && !controller.signal.aborted) error.value = onlineError(cause);
    }
  }
  function poll() {
    if (timer) clearTimeout(timer);
    if (!task.value || terminal(task.value.status)) return;
    const current = revision;
    timer = setTimeout(async () => {
      await refresh();
      if (current === revision) poll();
    }, 3000);
  }
  async function start() {
    stop();
    if (!task.value?.id || (customer && !token.value)) return;
    const current = revision;
    poll();
    try {
      const subscription = customer
        ? await onlineApi.publicSubscribe(task.value.id, token.value)
        : await onlineApi.action('jobs', 'subscribe', { id: task.value.id });
      if (current !== revision) return;
      const path = String(subscription.wsPath ?? '/api/id-business-v2/online-recharge/ws');
      const origin = String(import.meta.env.VITE_API_BASE_URL ?? window.location.origin);
      const url = new URL(path, origin.startsWith('http') ? origin : window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url.toString());
      socket.onopen = () => {
        if (current !== revision) return;
        socket?.send(JSON.stringify({ type: 'subscribe', ticket: subscription.ticket }));
        connected.value = true;
      };
      socket.onmessage = (event) => {
        if (current !== revision) return;
        try {
          const payload = JSON.parse(String(event.data));
          const update = payload.task ?? payload.data ?? payload;
          if (update.id === task.value?.id) {
            task.value = { ...task.value, ...update };
            if (terminal(update.status)) stop();
          }
        } catch {
          /* 由轮询补齐不完整事件。 */
        }
      };
      socket.onerror = () => {
        if (current === revision) connected.value = false;
      };
      socket.onclose = () => {
        if (current === revision) connected.value = false;
      };
    } catch {
      /* 票据不可用时继续查询同一个任务，不重建付款。 */
    }
  }
  watch([() => task.value?.id, () => token.value], () => void start(), { immediate: true });
  onScopeDispose(stop);
  return { error, connected, refresh, stop };
}
