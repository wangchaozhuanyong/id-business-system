import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, reactive, ref } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import type { TagProps } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2OrdersApi } from './api';
import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { useAuthStore } from '@/stores/auth';
import type {
  RefundV2OrderInput,
  UpdateV2OrderInput,
  V2Order,
  V2OrderListQuery,
  V2OrderListResult,
  V2OptionSelector,
  V2OrderStatus
} from './contracts';
import { hasUserPermission } from '@/utils/permissions';

const statusOptions: Array<{
  value: V2OrderStatus;
  label: string;
  type: TagProps['type'];
}> = [
  { value: 'draft', label: '草稿', type: 'info' },
  { value: 'pending', label: '待处理', type: 'warning' },
  { value: 'waiting_external', label: '等待 Apple 执行', type: 'warning' },
  { value: 'processing', label: '处理中', type: 'primary' },
  { value: 'completed', label: '已完成', type: 'success' },
  { value: 'refunded', label: '已退款', type: 'warning' },
  { value: 'cancelled', label: '已取消', type: 'info' },
  { value: 'failed', label: '失败', type: 'danger' }
];

interface OrdersReferenceOptions {
  services: V2OptionSelector[];
  settlementPlatforms: V2OptionSelector[];
}

interface OrdersPageSnapshot {
  list: V2OrderListResult;
  options: OrdersReferenceOptions;
}

const ORDERS_OPTIONS_SCOPE = 'orders-options';
const ORDERS_OPTIONS_KEY = 'selectors';

export function useOrdersPage() {
  const authStore = useAuthStore();
  const openedRange = ref<[string, string] | []>([]);
  const detailVisible = ref(false);
  const detailLoading = ref(false);
  const detailError = ref('');
  const detail = ref<V2Order | null>(null);
  const detailTarget = ref<V2Order | null>(null);
  const consumingOrderId = ref('');
  const completingOrderId = ref('');
  const editingOrder = ref<V2Order | null>(null);
  const editVisible = ref(false);
  const editSaving = ref(false);
  const refundingOrder = ref<V2Order | null>(null);
  const refundVisible = ref(false);
  const refundSaving = ref(false);
  const lifecycleBusyOrderId = ref('');
  const consumptionKeys = new Map<string, string>();
  const lifecycleKeys = new Map<string, string>();
  const canConsumeOrders = computed(() => hasUserPermission(authStore.user, 'apple.order.create'));
  const canUpdateOrders = computed(() => hasUserPermission(authStore.user, 'apple.order.update'));
  const canDeleteOrders = computed(() => hasUserPermission(authStore.user, 'apple.order.delete'));

  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    serviceOptionId: '',
    settlementPlatformOptionId: '',
    status: '' as V2OrderStatus | '',
    sortBy: 'openedAt' as NonNullable<V2OrderListQuery['sortBy']>,
    sortOrder: 'desc' as 'asc' | 'desc'
  });

  function getOrdersListQuery(): V2OrderListQuery {
    return {
      ...query,
      keyword: query.keyword.trim() || undefined,
      serviceOptionId: query.serviceOptionId || undefined,
      settlementPlatformOptionId: query.settlementPlatformOptionId || undefined,
      status: query.status || undefined,
      openedFrom: openedRange.value[0] || undefined,
      openedTo: openedRange.value[1] || undefined
    };
  }

  const ordersQuery = useV2ModuleQuery<OrdersPageSnapshot>({
    moduleKey: 'orders',
    scope: 'orders',
    key: () => createV2QueryKey(getOrdersListQuery()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getOrdersListQuery();
      const cachedOptions = getV2QueryData<OrdersReferenceOptions>(
        ORDERS_OPTIONS_SCOPE,
        ORDERS_OPTIONS_KEY,
        { tier: 'reference' }
      );
      if (cachedOptions) {
        return {
          list: await idBusinessV2OrdersApi.list(params, { signal }),
          options: cachedOptions
        };
      }

      const result = await idBusinessV2OrdersApi.bootstrap(params, { signal });
      primeV2Query({
        scope: ORDERS_OPTIONS_SCOPE,
        key: ORDERS_OPTIONS_KEY,
        data: result.options
      });
      return {
        list: result.list,
        options: result.options
      };
    }
  });

  const items = computed(() => ordersQuery.data.value?.list.items ?? []);
  const total = computed(() => ordersQuery.data.value?.list.total ?? 0);
  const serviceOptions = computed(() => ordersQuery.data.value?.options.services ?? []);
  const settlementOptions = computed(
    () => ordersQuery.data.value?.options.settlementPlatforms ?? []
  );
  const loading = computed(
    () => ordersQuery.isInitialLoading.value || ordersQuery.isRefreshing.value
  );
  const listError = computed(() =>
    ordersQuery.error.value ? getApiErrorMessage(ordersQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = ordersQuery;

  async function loadOrders() {
    await ordersQuery.refresh();
  }

  function loadCurrentOrders() {
    void ordersQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentOrders();
  }

  function handleFilterChange() {
    query.page = 1;
    loadCurrentOrders();
  }

  function handlePageSizeChange() {
    query.page = 1;
    loadCurrentOrders();
  }

  function handlePageChange() {
    loadCurrentOrders();
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported: Array<NonNullable<V2OrderListQuery['sortBy']>> = [
      'orderNo',
      'receivedAmount',
      'platformFeeAmount',
      'accountCostAmount',
      'balanceCostAmount',
      'refundCostAmount',
      'profitAmount',
      'balanceAmount',
      'status',
      'openedAt',
      'dueAt',
      'createdAt',
      'updatedAt'
    ];
    query.sortBy = supported.includes(sort.prop as NonNullable<V2OrderListQuery['sortBy']>)
      ? (sort.prop as NonNullable<V2OrderListQuery['sortBy']>)
      : 'openedAt';
    query.sortOrder = sort.order === 'ascending' ? 'asc' : 'desc';
    query.page = 1;
    loadCurrentOrders();
  }

  async function openDetail(item: V2Order) {
    detailTarget.value = item;
    detailVisible.value = true;
    detailLoading.value = true;
    detailError.value = '';
    detail.value = null;
    try {
      detail.value = await idBusinessV2OrdersApi.get(item.id);
    } catch (error) {
      detailError.value = getApiErrorMessage(error);
    } finally {
      detailLoading.value = false;
    }
  }

  function retryDetail() {
    if (detailTarget.value) void openDetail(detailTarget.value);
  }

  function openEdit(order: V2Order) {
    if (!canUpdateOrders.value || !order.operations.canEdit) return;
    editingOrder.value = order;
    editVisible.value = true;
  }

  async function updateOrder(payload: UpdateV2OrderInput) {
    const order = editingOrder.value;
    if (!order || !canUpdateOrders.value) return;

    editSaving.value = true;
    try {
      const updated = await idBusinessV2OrdersApi.update(order.id, payload);
      editVisible.value = false;
      editingOrder.value = updated;
      if (detail.value?.id === updated.id) detail.value = updated;
      ElMessage.success('订单已修改，金额、锁定和利润均由服务端重新核对');
      await loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      editSaving.value = false;
    }
  }

  function openRefund(order: V2Order) {
    if (!canUpdateOrders.value || !order.operations.canRefund) return;
    refundingOrder.value = order;
    refundVisible.value = true;
  }

  async function refundOrder(payload: Omit<RefundV2OrderInput, 'idempotencyKey'>) {
    const order = refundingOrder.value;
    if (!order || !canUpdateOrders.value) return;

    if (payload.restoreBalance) {
      try {
        await ElMessageBox.confirm(
          '该操作会真实增加 ID 余额并写入原消费的反向流水。只有确认业务没有开通时才能继续。',
          `确认恢复订单 ${order.orderNo} 的余额`,
          {
            type: 'warning',
            confirmButtonText: '确认恢复并退款',
            cancelButtonText: '返回核对'
          }
        );
      } catch {
        return;
      }
    }

    refundSaving.value = true;
    const keyName = `refund:${order.id}`;
    try {
      const result = await idBusinessV2OrdersApi.refund(order.id, {
        ...payload,
        idempotencyKey: getLifecycleKey('refund', order.id)
      });
      lifecycleKeys.delete(keyName);
      refundVisible.value = false;
      refundingOrder.value = result.order;
      if (detail.value?.id === order.id) detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay
          ? '已恢复原退款处理结果'
          : result.balanceRestored
            ? '退款已记录，原消费余额已按反向流水恢复'
            : '退款已记录，Apple 余额保持不变'
      );
      await loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      refundSaving.value = false;
    }
  }

  function hasLifecycleActions(order: V2Order) {
    return (
      (canUpdateOrders.value && (order.operations.canRefund || order.operations.canCancel)) ||
      (canDeleteOrders.value && order.operations.canDelete)
    );
  }

  function handleLifecycleCommand(command: unknown, order: V2Order) {
    if (command === 'refund') {
      openRefund(order);
    } else if (command === 'cancel') {
      void cancelOrder(order);
    } else if (command === 'delete') {
      void deleteOrder(order);
    }
  }

  async function cancelOrder(order: V2Order) {
    if (!canUpdateOrders.value || !order.operations.canCancel) return;
    const reason = await promptReason(
      '待处理订单会释放 ID 锁；已扣款但未开通的订单会按原流水精确恢复余额。',
      `取消订单 ${order.orderNo}`,
      '确认取消'
    );
    if (!reason) return;

    lifecycleBusyOrderId.value = order.id;
    const keyName = `cancel:${order.id}`;
    try {
      const result = await idBusinessV2OrdersApi.cancel(order.id, {
        reason,
        idempotencyKey: getLifecycleKey('cancel', order.id)
      });
      lifecycleKeys.delete(keyName);
      if (detail.value?.id === order.id) detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay
          ? '已恢复原取消结果'
          : result.balanceRestored
            ? '订单已取消，原消费余额已恢复'
            : '订单已取消，ID 锁已释放'
      );
      await loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      lifecycleBusyOrderId.value = '';
    }
  }

  async function deleteOrder(order: V2Order) {
    if (!canDeleteOrders.value || !order.operations.canDelete) return;
    const reason = await promptReason(
      '订单会从业务列表隐藏，但余额流水、退款证据和审计记录会完整保留。',
      `删除订单 ${order.orderNo}`,
      '确认删除'
    );
    if (!reason) return;

    lifecycleBusyOrderId.value = order.id;
    try {
      const result = await idBusinessV2OrdersApi.remove(order.id, { reason });
      if (detail.value?.id === order.id) {
        detailVisible.value = false;
        detail.value = null;
      }
      ElMessage.success(
        result.idempotentReplay ? '该订单已经删除' : '订单已软删除，账务证据已保留'
      );
      await loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      lifecycleBusyOrderId.value = '';
    }
  }

  async function promptReason(message: string, title: string, confirmButtonText: string) {
    try {
      const { value } = await ElMessageBox.prompt(message, title, {
        type: 'warning',
        inputType: 'textarea',
        inputPlaceholder: '请输入 2 至 500 个字符的操作原因',
        inputValidator: (input) => {
          const length = input.trim().length;
          return length >= 2 && length <= 500 ? true : '操作原因必须为 2 至 500 个字符';
        },
        confirmButtonText,
        cancelButtonText: '返回'
      });
      return value.trim();
    } catch (error) {
      if (error === 'cancel' || error === 'close') return null;
      ElMessage.error(getApiErrorMessage(error));
      return null;
    }
  }

  async function consumeOrderBalance(order: V2Order) {
    if (!canConsumeOrders.value || !order.operations.canConsume) return;
    try {
      await ElMessageBox.confirm(
        `将真实扣减 ${formatDecimal(order.balanceAmount)} 余额，并写入成本流水。确认继续？`,
        `扣减订单 ${order.orderNo}`,
        {
          type: 'warning',
          confirmButtonText: '确认扣减',
          cancelButtonText: '取消'
        }
      );
    } catch {
      return;
    }

    consumingOrderId.value = order.id;
    const idempotencyKey = getConsumptionKey(order.id);
    try {
      const result = await idBusinessV2OrdersApi.consumeBalance(order.id, {
        idempotencyKey
      });
      consumptionKeys.delete(order.id);
      ElMessage.success(
        result.idempotentReplay ? '已恢复原扣款流水结果' : '余额已真实扣减，利润已计算'
      );
      await loadOrders();
      if (detail.value?.id === order.id) {
        detail.value = result.order;
      }
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      consumingOrderId.value = '';
    }
  }

  async function completeOrder(order: V2Order) {
    if (!canUpdateOrders.value || !order.operations.canComplete) return;
    try {
      await ElMessageBox.confirm(
        '确认 Apple 官网业务已经真实开通。系统会核对原扣款流水，并在同一事务中生成开通记录和完成订单。',
        `确认订单 ${order.orderNo} 已开通`,
        {
          type: 'warning',
          confirmButtonText: '确认已真实开通',
          cancelButtonText: '返回核对'
        }
      );
    } catch {
      return;
    }

    completingOrderId.value = order.id;
    try {
      const result = await idBusinessV2OrdersApi.complete(order.id);
      if (detail.value?.id === order.id) detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay ? '已恢复原开通记录' : '订单已完成，开通记录已生成'
      );
      await loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await loadOrders();
    } finally {
      completingOrderId.value = '';
    }
  }

  function getConsumptionKey(orderId: string) {
    const existing = consumptionKeys.get(orderId);
    if (existing) return existing;
    const key =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `consume-${crypto.randomUUID()}`
        : `consume-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    consumptionKeys.set(orderId, key);
    return key;
  }

  function getLifecycleKey(action: 'cancel' | 'refund', orderId: string) {
    const name = `${action}:${orderId}`;
    const existing = lifecycleKeys.get(name);
    if (existing) return existing;
    const key =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `${action}-${crypto.randomUUID()}`
        : `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    lifecycleKeys.set(name, key);
    return key;
  }

  function statusMeta(status: V2OrderStatus) {
    return (
      statusOptions.find((option) => option.value === status) ?? {
        value: status,
        label: status,
        type: 'info' as const
      }
    );
  }

  function lockScopeLabel(value: 'by_service' | 'global') {
    return value === 'global' ? '整个 ID' : '当前业务';
  }

  function selectorLabel(option: V2OptionSelector) {
    return [option.country?.name, option.parent?.name, option.name].filter(Boolean).join(' / ');
  }

  function formatDecimal(value: string) {
    const [integer, fraction = ''] = value.split('.');
    const trimmedFraction = fraction.replace(/0+$/, '');
    return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  }

  function formatNullableDecimal(value: string | null) {
    return value === null ? '-' : formatDecimal(value);
  }

  function profitClass(value: string | null) {
    if (value === null || Number(value) === 0) return 'v2-order-money';
    return Number(value) > 0 ? 'v2-order-profit--positive' : 'v2-order-profit--negative';
  }

  function formatDate(value: string | null) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  return {
    statusOptions,
    items,
    total,
    loading,
    listError,
    serviceOptions,
    settlementOptions,
    openedRange,
    detailVisible,
    detailLoading,
    detailError,
    detail,
    detailTarget,
    consumingOrderId,
    completingOrderId,
    editingOrder,
    editVisible,
    editSaving,
    refundingOrder,
    refundVisible,
    refundSaving,
    lifecycleBusyOrderId,
    canConsumeOrders,
    canUpdateOrders,
    canDeleteOrders,
    query,
    loadOrders,
    handleSearch,
    handleFilterChange,
    handlePageSizeChange,
    handlePageChange,
    handleSortChange,
    openDetail,
    retryDetail,
    openEdit,
    updateOrder,
    openRefund,
    refundOrder,
    hasLifecycleActions,
    handleLifecycleCommand,
    cancelOrder,
    deleteOrder,
    consumeOrderBalance,
    completeOrder,
    statusMeta,
    lockScopeLabel,
    selectorLabel,
    formatDecimal,
    formatNullableDecimal,
    profitClass,
    formatDate,
    hasLoadedOnce,
    isInitialLoading
  };
}
