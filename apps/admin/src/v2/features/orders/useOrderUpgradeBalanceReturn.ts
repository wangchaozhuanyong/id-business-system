import { ref, type ComputedRef, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2OrdersApi } from './api';
import type { RecordV2OrderUpgradeBalanceReturnInput, V2Order } from './contracts';
import { getOrCreateOrderActionKey } from './order-idempotency';
import { formatDecimal } from './order-presentation';

interface UseOrderUpgradeBalanceReturnInput {
  canUpdateOrders: ComputedRef<boolean>;
  detail: Ref<V2Order | null>;
  lifecycleBusyOrderId: Ref<string>;
  actionKeys: Map<string, string>;
  isOrderActionUnavailable: (allowed: boolean) => boolean;
  loadOrders: () => Promise<void>;
  promptReason: (
    message: string,
    title: string,
    confirmButtonText: string
  ) => Promise<string | null>;
}

export function useOrderUpgradeBalanceReturn(input: UseOrderUpgradeBalanceReturnInput) {
  const order = ref<V2Order | null>(null);
  const visible = ref(false);
  const saving = ref(false);

  function open(target: V2Order) {
    if (
      input.isOrderActionUnavailable(
        input.canUpdateOrders.value && target.operations.canRecordUpgradeBalanceReturn
      )
    ) {
      return;
    }
    order.value = target;
    visible.value = true;
  }

  async function record(payload: Omit<RecordV2OrderUpgradeBalanceReturnInput, 'idempotencyKey'>) {
    const target = order.value;
    if (!target || !input.canUpdateOrders.value) return;

    saving.value = true;
    const keyName = `upgrade-return:${target.id}`;
    try {
      const result = await idBusinessV2OrdersApi.recordUpgradeBalanceReturn(target.id, {
        ...payload,
        idempotencyKey: getOrCreateOrderActionKey(input.actionKeys, 'upgrade-return', target.id)
      });
      input.actionKeys.delete(keyName);
      visible.value = false;
      order.value = result.order;
      if (input.detail.value?.id === target.id) input.detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay
          ? '已恢复原升级退币登记结果'
          : `已向原 ID 恢复 ${formatDecimal(result.balanceReturn.returnedBalanceAmount)} ${result.balanceReturn.currencyCode}，订单收入保持不变`
      );
      await input.loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await input.loadOrders();
    } finally {
      saving.value = false;
    }
  }

  async function reverse(target: V2Order) {
    if (
      input.isOrderActionUnavailable(
        input.canUpdateOrders.value && target.operations.canReverseUpgradeBalanceReturn
      )
    ) {
      return;
    }
    const balanceReturn = target.upgradeBalanceReturn;
    if (!balanceReturn || balanceReturn.status !== 'active') return;
    const reason = await input.promptReason(
      `将从原 ID 扣回 ${formatDecimal(balanceReturn.returnedBalanceAmount)} ${balanceReturn.currencyCode}，并精确恢复登记前的订单成本和利润。若该余额已被后续消费，系统会拒绝撤销。`,
      `撤销订单 ${target.orderNo} 的升级退币`,
      '确认撤销'
    );
    if (!reason) return;

    input.lifecycleBusyOrderId.value = target.id;
    const keyName = `upgrade-return-reverse:${target.id}`;
    try {
      const result = await idBusinessV2OrdersApi.reverseUpgradeBalanceReturn(target.id, {
        reason,
        idempotencyKey: getOrCreateOrderActionKey(
          input.actionKeys,
          'upgrade-return-reverse',
          target.id
        )
      });
      input.actionKeys.delete(keyName);
      if (input.detail.value?.id === target.id) input.detail.value = result.order;
      ElMessage.success(
        result.idempotentReplay ? '已恢复原撤销结果' : '升级退币已撤销，订单成本和利润已恢复'
      );
      await input.loadOrders();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await input.loadOrders();
    } finally {
      input.lifecycleBusyOrderId.value = '';
    }
  }

  return { order, visible, saving, open, record, reverse };
}
