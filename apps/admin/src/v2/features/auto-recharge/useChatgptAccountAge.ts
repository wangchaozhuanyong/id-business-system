import { onMounted, onUnmounted, ref } from 'vue';
import { ensureV2BusinessNowMs, getV2BusinessNowMs } from '@/v2/runtime/businessClock';

export function chatgptAccountRegisteredDays(createdAt: string, now: number | null) {
  const registeredAt = Date.parse(createdAt);
  if (now === null || !Number.isFinite(now) || !Number.isFinite(registeredAt)) return null;
  return Math.max(0, Math.floor((now - registeredAt) / (24 * 60 * 60 * 1000)));
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
  function registeredDaysLabel(createdAt: string) {
    if (now.value === null) return '时间同步中';
    const days = chatgptAccountRegisteredDays(createdAt, now.value);
    return days === null ? '未记录' : `${days} 天`;
  }
  return { registeredDaysLabel };
}
