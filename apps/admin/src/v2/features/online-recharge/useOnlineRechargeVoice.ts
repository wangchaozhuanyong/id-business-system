import { computed, onScopeDispose, reactive, readonly, watch } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { subscribeV2ScopeChanges } from '@/v2/runtime/changeSync';
import { onlineApi } from './api';
import { createRechargeVoice, type RechargeVoiceState } from './rechargeVoice';

export function useOnlineRechargeVoice() {
  const auth = useAuthStore();
  const allowed = computed(
    () =>
      Boolean(auth.user?.id) && hasUserPermission(auth.user, 'id_business_v2.online_recharge.read')
  );
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window &&
    Boolean(navigator.locks);
  const voiceState = reactive<RechargeVoiceState>({
    status: 'off',
    message: supported ? '开启后播报新开始执行的充值套餐。' : '此浏览器暂不支持语音播报。',
    error: false
  });
  const voice = createRechargeVoice({
    allowed: () => allowed.value && supported,
    read: (cursor, signal) => onlineApi.rechargeAnnouncements(cursor, signal),
    async withLock(work) {
      await navigator.locks.request(
        `id-business:online-recharge-voice:${auth.user?.id}`,
        { ifAvailable: true },
        (lock) => work(Boolean(lock))
      );
    },
    speak(text, onError) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      const chinese = window.speechSynthesis
        .getVoices()
        .find((item) => /^zh(?:-|_)/i.test(item.lang));
      if (chinese) utterance.voice = chinese;
      utterance.onerror = onError;
      window.speechSynthesis.speak(utterance);
    },
    cancel: () => window.speechSynthesis.cancel(),
    subscribe(refresh) {
      const unsubscribe = subscribeV2ScopeChanges((scopes) => {
        if (scopes.includes('online-recharge')) refresh();
      });
      const foreground = () => {
        if (document.visibilityState !== 'hidden') refresh();
      };
      window.addEventListener('online', foreground);
      window.addEventListener('focus', foreground);
      document.addEventListener('visibilitychange', foreground);
      return () => {
        unsubscribe();
        window.removeEventListener('online', foreground);
        window.removeEventListener('focus', foreground);
        document.removeEventListener('visibilitychange', foreground);
      };
    },
    update: (next) => Object.assign(voiceState, next)
  });
  const unsubscribeIdentity = sessionCoordinator.subscribeIdentityChange(() => voice.stop());
  const stopPermissionWatch = watch([() => auth.user?.id, allowed], () => voice.stop());
  onScopeDispose(() => {
    unsubscribeIdentity();
    stopPermissionWatch();
    voice.stop();
  });
  return { state: readonly(voiceState), allowed, supported, ...voice };
}
