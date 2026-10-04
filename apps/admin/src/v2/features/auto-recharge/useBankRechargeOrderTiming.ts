import { onMounted, onUnmounted, ref, watch } from 'vue';
import { bankRechargeDefaultDueAt } from '@apple-business/shared';
import { ensureV2BusinessNowMs, getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import type { BankRechargeOrder } from './bank-recharge-api';

function defaultDueAt(openedAt: string) {
  return openedAt
    ? toV2DateTimeInput(bankRechargeDefaultDueAt(v2DateTimeInputToIso(openedAt)))
    : '';
}

export function useBankRechargeOrderTiming(
  form: { openedAt: string; dueAt: string },
  requiresDateVerification: () => boolean = () => false
) {
  const businessNow = ref<number | null>(getV2BusinessNowMs());
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(async () => {
    businessNow.value = await ensureV2BusinessNowMs();
    if (!disposed) timer = setInterval(() => (businessNow.value = getV2BusinessNowMs()), 1000);
  });
  onUnmounted(() => {
    disposed = true;
    if (timer) clearInterval(timer);
  });
  watch(
    () => form.openedAt,
    (openedAt, previous) => {
      if (requiresDateVerification()) return;
      if (!form.dueAt || (previous && form.dueAt === defaultDueAt(previous))) {
        form.dueAt = defaultDueAt(openedAt);
      }
    }
  );
  function initializeDates() {
    if (!form.openedAt && businessNow.value !== null) {
      form.openedAt = toV2DateTimeInput(businessNow.value);
      form.dueAt = defaultDueAt(form.openedAt);
    }
  }
  function usageLabel(row: BankRechargeOrder) {
    if (row.source === 'automatic' && !row.accountId) return '账号归属待核验';
    if (row.source === 'automatic' && (!row.openedAt || !row.dueAt)) return '开通时间待核对';
    if (businessNow.value === null) return '时间同步中';
    if (row.dueAt && Date.parse(row.dueAt) <= businessNow.value) return '已到期';
    if (row.activeSubscription?.status !== 'active') {
      return row.accountId ? '非当前使用' : '待关联账号';
    }
    return '使用中';
  }
  function usageTagType(row: BankRechargeOrder) {
    const label = usageLabel(row);
    return label === '使用中' ? 'success' : label === '已到期' ? 'warning' : 'info';
  }
  return { usageLabel, usageTagType, initializeDates };
}
