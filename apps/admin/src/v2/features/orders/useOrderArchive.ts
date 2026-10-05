import { computed, reactive, ref, type ComputedRef } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2OrdersApi } from './api';
import { getOrCreateOrderActionKey } from './order-idempotency';
import type { V2Order } from './contracts';

export type OrderArchiveAction = 'archive' | 'unarchive';
export interface OrderArchiveTarget {
  id: string;
  orderNo: string;
  expectedUpdatedAt: string;
}

const ARCHIVABLE_STATUSES = new Set(['completed', 'refunded', 'cancelled', 'failed']);
export function canArchiveOrder(order: V2Order) {
  return (
    !order.archivedAt &&
    ARCHIVABLE_STATUSES.has(order.status) &&
    order.operations.canArchive !== false
  );
}

export function canUnarchiveOrder(order: V2Order) {
  return Boolean(order.archivedAt) && order.operations.canUnarchive !== false;
}

interface ArchivePageInput {
  canUpdateOrders: ComputedRef<boolean>;
  isOrderActionUnavailable: (allowed: boolean) => boolean;
  loadOrders: () => Promise<void>;
  closeDetail: (id: string) => void;
}

export function useOrderArchive(input: ArchivePageInput) {
  const ownerEpoch = sessionCoordinator.identityEpoch.value;
  const currentOwner = () => ownerEpoch === sessionCoordinator.identityEpoch.value;
  const visible = ref(false);
  const saving = ref(false);
  const mode = ref<OrderArchiveAction>('archive');
  const selected = useV2SessionDraft('orders/orderArchive:selected', () =>
    ref<OrderArchiveTarget[]>([])
  );
  const completed = useV2SessionDraft('orders/orderArchive:completed', () =>
    reactive(new Map<string, Set<string>>())
  );
  const actionKeys = useV2SessionDraft(
    'orders/orderArchive:actionKeys',
    () => new Map<string, string>()
  );
  const draft = useV2FormDraft('orders/orderArchive:confirmation', () => ({
    reason: '',
    targets: [] as OrderArchiveTarget[]
  }));
  const failures = ref<Array<{ id: string; message: string }>>([]);
  const manifestKey = ref('');
  const selectedCount = computed(() => selected.value.length);
  const completedIds = computed(() => completed.get(manifestKey.value) ?? new Set<string>());
  const disabledReason = computed(() =>
    !currentOwner()
      ? '会话身份已变更，请重新打开订单页面'
      : !input.canUpdateOrders.value
        ? '没有修改订单权限'
        : draft.form.targets.length === 0
          ? '未选择订单'
          : input.isOrderActionUnavailable(true)
            ? '正在切换筛选，请等待订单列表加载'
            : ''
  );

  function isSelected(order: V2Order) {
    return selected.value.some((target) => target.id === order.id);
  }
  function select(order: V2Order, checked: unknown) {
    if (
      !currentOwner() ||
      saving.value ||
      input.isOrderActionUnavailable(input.canUpdateOrders.value)
    )
      return;
    if (checked === true) {
      if (!canArchiveOrder(order)) return;
      if (isSelected(order)) return;
      if (selected.value.length >= 100) {
        ElMessage.warning('每次最多选择 100 笔订单');
        return;
      }
      selected.value.push(targetOf(order));
    } else selected.value = selected.value.filter((target) => target.id !== order.id);
  }
  function clearSelection() {
    if (currentOwner() && !saving.value) selected.value = [];
  }
  function open(targets: OrderArchiveTarget[], action: OrderArchiveAction) {
    if (
      !currentOwner() ||
      saving.value ||
      input.isOrderActionUnavailable(input.canUpdateOrders.value) ||
      !targets.length
    )
      return;
    mode.value = action;
    draft.open(confirmationKey(targets, action), {
      reason: '',
      targets: targets.map((target) => ({ ...target }))
    });
    manifestKey.value = progressKey(draft.form.targets, action);
    // 重新打开只恢复输入；旧轮次的成功结果不能代表现在仍然归档。
    completed.delete(manifestKey.value);
    failures.value = [];
    visible.value = true;
  }
  function openArchive(order: V2Order) {
    if (canArchiveOrder(order)) open([targetOf(order)], 'archive');
  }
  function openUnarchive(order: V2Order) {
    if (canUnarchiveOrder(order)) open([targetOf(order)], 'unarchive');
  }
  function openSelected() {
    open(selected.value, 'archive');
  }

  async function recheckFailed() {
    if (!currentOwner() || saving.value || disabledReason.value) return;
    const epoch = sessionCoordinator.identityEpoch.value;
    const currentIdentity = () => epoch === sessionCoordinator.identityEpoch.value;
    const failedIds = failures.value.map((failure) => failure.id);
    saving.value = true;
    const done = completed.get(manifestKey.value) ?? reactive(new Set<string>());
    completed.set(manifestKey.value, done);
    const refreshedFailures: typeof failures.value = [];
    try {
      for (const id of failedIds) {
        if (!currentIdentity()) return;
        try {
          const current = await idBusinessV2OrdersApi.get(id);
          if (!currentIdentity()) return;
          if (current.id !== id) throw new Error('订单查询响应不一致');
          const desired =
            mode.value === 'archive' ? Boolean(current.archivedAt) : !current.archivedAt;
          if (desired) {
            done.add(id);
            continue;
          }
          if (!(mode.value === 'archive' ? canArchiveOrder(current) : canUnarchiveOrder(current))) {
            throw new Error('订单当前不可执行该操作，请核对处理状态');
          }
          const target = draft.form.targets.find((item) => item.id === id);
          if (target) target.expectedUpdatedAt = current.updatedAt;
        } catch (error) {
          if (!currentIdentity()) return;
          refreshedFailures.push({ id, message: getApiErrorMessage(error) });
        }
      }
      if (!currentIdentity()) return;
      failures.value = refreshedFailures;
    } finally {
      saving.value = false;
    }
  }

  async function submit() {
    if (!currentOwner() || saving.value || disabledReason.value) return;
    const reason = draft.form.reason.trim();
    if (reason.length < 2 || reason.length > 500) return;
    const epoch = sessionCoordinator.identityEpoch.value;
    const currentIdentity = () => epoch === sessionCoordinator.identityEpoch.value;
    const completeSave = draft.beginSave();
    const action = mode.value;
    const key = manifestKey.value;
    const targets = draft.form.targets.map((target) => ({ ...target }));
    const done = completed.get(key) ?? reactive(new Set<string>());
    completed.set(key, done);
    saving.value = true;
    failures.value = [];
    try {
      for (const target of targets) {
        if (!currentIdentity()) return;
        try {
          if (done.has(target.id)) {
            const current = await idBusinessV2OrdersApi.get(target.id);
            if (!currentIdentity()) return;
            assertCurrentState(current, target.id, action);
            selected.value = selected.value.filter((item) => item.id !== target.id);
            continue;
          }
          const result = await idBusinessV2OrdersApi[action](target.id, {
            expectedUpdatedAt: target.expectedUpdatedAt,
            reason,
            idempotencyKey: getOrCreateOrderActionKey(
              actionKeys,
              action,
              `${target.id}:${target.expectedUpdatedAt}:${reason}`
            )
          });
          if (!currentIdentity()) return;
          if (result.id !== target.id || (action === 'archive') !== Boolean(result.archivedAt)) {
            throw new Error('订单归档响应不一致，请重新核对');
          }
          if (result.idempotentReplay) {
            const current = await idBusinessV2OrdersApi.get(target.id);
            if (!currentIdentity()) return;
            assertCurrentState(current, target.id, action);
          }
          done.add(target.id);
          selected.value = selected.value.filter((item) => item.id !== target.id);
          input.closeDetail(target.id);
        } catch (error) {
          if (!currentIdentity()) return;
          done.delete(target.id);
          failures.value.push({ id: target.id, message: getApiErrorMessage(error) });
        }
      }
      if (!currentIdentity()) return;
      if (!failures.value.length) {
        if (completeSave()) {
          visible.value = false;
          completed.delete(key);
        }
        ElMessage.success(
          action === 'archive'
            ? '订单已归档，全部账务和 ID 来源已保留'
            : '订单已恢复到当前列表，未改变账务和资金'
        );
      } else {
        ElMessage.warning(
          `已完成 ${done.size} 笔，${failures.value.length} 笔未完成；可重试未完成订单`
        );
        if (completeSave()) {
          const remaining = targets.filter((target) => !done.has(target.id));
          const retainedReason = draft.form.reason;
          completed.delete(key);
          draft.open(confirmationKey(remaining, action), {
            reason: retainedReason,
            targets: remaining
          });
          manifestKey.value = progressKey(draft.form.targets, action);
        }
      }
      if (currentIdentity()) await input.loadOrders();
    } finally {
      saving.value = false;
    }
  }

  return {
    visible,
    saving,
    mode,
    form: draft.form,
    failures,
    selectedCount,
    completedIds,
    disabledReason,
    canArchive: canArchiveOrder,
    canUnarchive: canUnarchiveOrder,
    isSelected,
    select,
    clearSelection,
    openArchive,
    openUnarchive,
    openSelected,
    recheckFailed,
    submit
  };
}

function targetOf(order: V2Order): OrderArchiveTarget {
  return { id: order.id, orderNo: order.orderNo, expectedUpdatedAt: order.updatedAt };
}

function confirmationKey(targets: OrderArchiveTarget[], action: OrderArchiveAction) {
  return `${action}:${targets
    .map((target) => target.id)
    .sort()
    .join(':')}`;
}

function progressKey(targets: OrderArchiveTarget[], action: OrderArchiveAction) {
  return `${action}:${targets
    .map((target) => `${target.id}@${target.expectedUpdatedAt}`)
    .sort()
    .join(':')}`;
}

function assertCurrentState(order: V2Order, id: string, action: OrderArchiveAction) {
  if (order.id !== id || (action === 'archive') !== Boolean(order.archivedAt)) {
    throw new Error('订单已发生后续归档或恢复，请重新核对未完成订单');
  }
}
