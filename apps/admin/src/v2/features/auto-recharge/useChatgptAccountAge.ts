import { onMounted, onUnmounted, ref } from 'vue';
import { ensureV2BusinessNowMs, getV2BusinessNowMs } from '@/v2/runtime/businessClock';

export function chatgptAccountRegisteredDays(registeredAt: string | null, now: number | null) {
  const timestamp = registeredAt ? Date.parse(registeredAt) : NaN;
  if (now === null || !Number.isFinite(now) || !Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / (24 * 60 * 60 * 1000)));
}

export function useChatgptAccountAge() {
  const now = ref<number | null>(getV2BusinessNowMs());
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(async () => {
    now.value = await ensureV2BusinessNowMs();
    if (!disposed) timer = setInterval(() => (now.value = getV2BusinessNowMs()), 1000);
  });
  onUnmounted(() => {
    disposed = true;
    if (timer) clearInterval(timer);
  });
  function registeredDaysLabel(registeredAt: string | null) {
    if (!registeredAt) return '未记录';
    if (now.value === null) return '时间同步中';
    const days = chatgptAccountRegisteredDays(registeredAt, now.value);
    return days === null ? '未记录' : `${days} 天`;
  }
  return { registeredDaysLabel };
}
