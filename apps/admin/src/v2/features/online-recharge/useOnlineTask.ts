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
  let requestSequence = 0;
  let finalizing = false;
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
  async function finish() {
    if (finalizing) return;
    finalizing = true;
    const current = revision;
    if (timer) clearTimeout(timer);
    socket?.close();
    try {
      if (!customer) await refresh(true);
    } finally {
      if (current === revision) stop();
    }
  }
  async function refresh(includeEvents = false) {
    if (!task.value?.id || (customer && !token.value)) return;
    const current = revision;
    const sequence = ++requestSequence;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const value = customer
        ? await onlineApi.task(task.value.id, token.value, requestController.signal)
        : await onlineApi.action(
            'jobs',
            'detail',
            { id: task.value.id, includeEvents },
            requestController.signal
          );
      if (
        current === revision &&
        sequence === requestSequence &&
        !requestController.signal.aborted
      ) {
        task.value = value as unknown as PublicTask;
        error.value = '';
        if (terminal(task.value.status)) {
          if (!includeEvents) await finish();
        }
      }
    } catch (cause) {
      if (current === revision && sequence === requestSequence && !requestController.signal.aborted)
        error.value = onlineError(cause);
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
    finalizing = false;
    if (!task.value?.id || (customer && !token.value)) return;
    if (terminal(task.value.status)) return;
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
            if (terminal(update.status)) {
              void finish();
            }
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
  return { error, connected, refresh: () => refresh(), stop };
}
