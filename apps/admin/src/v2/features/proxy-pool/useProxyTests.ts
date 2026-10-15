import { computed, onScopeDispose, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { proxyPoolApi } from './api';
import type { ProxyTestTask } from './contracts';

export function isProxyTestActive(task?: ProxyTestTask) {
  return Boolean(
    task &&
    ['queued', 'running'].includes(task.status) &&
    !(task.status === 'queued' && (task.requiresResubmission || task.connectionChanged))
  );
}

export function proxyTestTaskLabel(task: ProxyTestTask, now = Date.now()) {
  if (task.connectionChanged)
    return task.status === 'running'
      ? '连接资料已修改，旧检测仍在执行，结束后请重新检测'
      : '连接资料已修改，请重新检测';
  if (task.status === 'queued' && task.requiresResubmission)
    return '旧检测缺少连接版本，请重新检测';
  if (task.status === 'queued')
    return now - Date.parse(task.createdAt) >= 120000
      ? '排队超过 2 分钟，可能执行器繁忙或不可用；任务仍在排队，请勿重复提交'
      : '等待执行';
  if (task.status === 'running') return `检测中（${Math.min(100, Math.max(0, task.progress))}%）`;
  if (task.status === 'awaiting_credentials')
    return '上次检测缺少执行资料，请检查执行器配置后重新检测';
  if (task.status === 'awaiting_review') return '上次检测结果待核对，请检查执行器状态后重新检测';
  if (task.status === 'succeeded') return task.message || '检测成功';
  return task.message || '检测失败，可重试';
}

export function useProxyTests(options: {
  proxyIds: () => string[];
  enabled: () => boolean;
  onSettled: () => Promise<unknown>;
}) {
  const trackedProxyIds = useV2SessionDraft('proxy-pool/test-monitor', () => ref<string[]>([]));
  const submitted = ref<ProxyTestTask[]>([]);
  const submitting = ref(false);
  const feedback = ref('');
  const failed = ref(false);
  const proxyIds = computed(() =>
    [...new Set([...options.proxyIds(), ...trackedProxyIds.value])].sort()
  );
  const query = useV2ModuleQuery({
    moduleKey: 'recharge-proxies',
    scope: 'online-recharge',
    trackRouteData: false,
    key: () => createV2QueryKey({ kind: 'proxy-test-tasks', proxyIds: proxyIds.value }),
    enabled: () => options.enabled() && proxyIds.value.length > 0,
    query: ({ signal }) => proxyPoolApi.testTasks(proxyIds.value, { signal }),
    getRevalidateAt: (data) => data.revalidateAt
  });
  const tasks = computed(() => {
    const latest = new Map<string, ProxyTestTask>();
    for (const task of [...submitted.value, ...(query.data.value?.items ?? [])]) {
      if (!proxyIds.value.includes(task.proxyId)) continue;
      const previous = latest.get(task.proxyId);
      if (!previous || task.updatedAt >= previous.updatedAt) latest.set(task.proxyId, task);
    }
    return [...latest.values()];
  });
  const activeTasks = computed(() => tasks.value.filter(isProxyTestActive));
  const hasActive = computed(() => activeTasks.value.length > 0);
  const summary = computed(() => {
    const queued = activeTasks.value.filter((task) => task.status === 'queued');
    const running = activeTasks.value.length - queued.length;
    const succeeded = tasks.value.filter(
      (task) => task.status === 'succeeded' && !task.connectionChanged
    ).length;
    const failures = tasks.value.filter(
      (task) => task.status === 'failed' && !task.connectionChanged
    ).length;
    const changed = tasks.value.filter((task) => task.connectionChanged).length;
    const interrupted = tasks.value.filter(
      (task) =>
        !task.connectionChanged && ['awaiting_credentials', 'awaiting_review'].includes(task.status)
    ).length;
    const legacy = tasks.value.filter(
      (task) => task.status === 'queued' && task.requiresResubmission
    ).length;
    const counts = [
      queued.length ? `等待执行 ${queued.length} 个` : '',
      running ? `执行中 ${running} 个` : '',
      succeeded ? `成功 ${succeeded} 个` : '',
      failures ? `失败 ${failures} 个，可在对应代理的更多操作中重试` : '',
      changed ? `连接资料已修改 ${changed} 个，请重新检测` : '',
      interrupted ? `历史检测异常 ${interrupted} 个，请检查执行器后重新检测` : '',
      legacy ? `旧检测 ${legacy} 个缺少连接版本，请重新检测` : ''
    ].filter(Boolean);
    const overdue = queued.some((task) => Date.now() - Date.parse(task.createdAt) >= 120000);
    return counts.length
      ? `最近检测：${counts.join('，')}${overdue ? '。排队超过 2 分钟，可能执行器繁忙或不可用；任务仍在排队，请勿重复提交。' : ''}`
      : '暂无检测任务';
  });
  const observedActiveIds = new Set<string>();
  let active = true;
  watch(
    tasks,
    (value) => {
      let settled = false;
      for (const task of value) {
        if (isProxyTestActive(task)) observedActiveIds.add(task.id);
        else if (observedActiveIds.delete(task.id)) settled = true;
      }
      if (settled) void options.onSettled();
    },
    { immediate: true }
  );
  const stopIdentity = sessionCoordinator.subscribeIdentityChange(() => {
    submitted.value = [];
    observedActiveIds.clear();
    feedback.value = '';
  });
  onScopeDispose(() => {
    active = false;
    stopIdentity();
  });
  function taskFor(id: string) {
    return tasks.value.find((task) => task.proxyId === id);
  }
  async function start(id?: string) {
    if (
      !options.enabled() ||
      submitting.value ||
      (id ? isProxyTestActive(taskFor(id)) : hasActive.value)
    )
      return;
    submitting.value = true;
    failed.value = false;
    feedback.value = '';
    const identity = sessionCoordinator.identityEpoch.value;
    try {
      const result = await proxyPoolApi.test(id);
      if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
      const returnedIds = new Set(result.tasks.map((task) => task.proxyId));
      submitted.value = [
        ...submitted.value.filter((task) => !returnedIds.has(task.proxyId)),
        ...result.tasks
      ];
      trackedProxyIds.value = [...new Set([...returnedIds, ...trackedProxyIds.value])].slice(
        0,
        500
      );
      feedback.value = result.tasks.length
        ? `${result.reused ? '已继续跟踪现有' : '已提交'} ${result.tasks.length} 个检测任务，结果将自动更新`
        : '暂无启用代理可检测';
      await query.refresh();
    } catch (cause) {
      if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
      failed.value = true;
      feedback.value = getApiErrorMessage(cause);
    } finally {
      if (active && identity === sessionCoordinator.identityEpoch.value) submitting.value = false;
    }
  }
  return { query, tasks, hasActive, submitting, feedback, failed, summary, taskFor, start };
}
