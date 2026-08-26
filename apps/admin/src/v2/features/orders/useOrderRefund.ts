import { ref, type ComputedRef, type Ref } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2OrdersApi } from './api';
import type { RefundV2OrderInput, V2Order } from './contracts';
import { getOrCreateOrderActionKey } from './order-idempotency';
import { formatDecimal } from './order-presentation';

interface UseOrderRefundInput {
  canUpdateOrders: ComputedRef<boolean>;
  detail: Ref<V2Order | null>;
  actionKeys: Map<string, string>;
  isOrderActionUnavailable: (allowed: boolean) => boolean;
  loadOrders: () => Promise<void>;
}

export function useOrderRefund(input: UseOrderRefundInput) {
  const order = ref<V2Order | null>(null);
  const visible = ref(false);
  const saving = ref(false);

  function open(target: V2Order) {
    if (
      input.isOrderActionUnavailable(input.canUpdateOrders.value && target.operations.canRefund)
    ) {
      return;
    }
    order.value = target;
    visible.value = true;
  }

  async function refund(payload: Omit<RefundV2OrderInput, 'idempotencyKey'>) {
    const target = order.value;
    if (!target || !input.canUpdateOrders.value) return;

    if (payload.balanceRefundMode !== 'none') {
      const description =
        payload.balanceRefundMode === 'full'
          ? `尚未退回余额 ${formatDecimal(target.remainingRefundableBalanceAmount)} ${target.balanceCurrencyCode || '原币'}`
          : `自定义余额 ${formatDecimal(payload.customRefundBalanceAmount ?? '0')} ${target.balanceCurrencyCode || '原币'}`;
      try {
        await ElMessageBox.confirm(
          `该操作会向 ID 退回${description}，并按原消费流水恢复对应人民币成本。请确认余额已实际退回。`,
          `确认处理订单 ${target.orderNo} 的退款`,
          {
            type: 'warning',
            confirmButtonText: '确认退款',
            cancelButtonText: '返回核对'
          }
        );
      } catch {
        return;
      }
    }

    saving.value = true;
    const keyName = `refund:${target.id}`;
    try {
      const result = await idBusinessV2OrdersApi.refund(target.id, {
        ...payload,
        idempotencyKey: getOrCreateOrderActionKey(input.actionKeys, 'refund', target.id)
      });
      input.actionKeys.delete(keyName);
      visible.value = false;
      order.value = result.order;
      if (input.detail.value?.id === target.id) input.detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay
          ? '已恢复原退款处理结果'
          : target.accountDisposition === 'sold'
            ? result.balanceRestored
              ? `订单已全额退款，ID 已恢复可用，已退回 ${formatDecimal(result.reversalLedger?.balanceAmount ?? '0')} ID 余额`
              : '订单已全额退款，ID 已恢复可用，当前余额保持不变'
            : result.balanceRestored
              ? `订单已全额退款，已退回 ${formatDecimal(result.reversalLedger?.balanceAmount ?? '0')} ID 余额`
              : '订单已全额退款，ID 当前余额保持不变'
      );
      await input.loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await input.loadOrders();
    } finally {
      saving.value = false;
    }
  }

  return { order, visible, saving, open, refund };
}
