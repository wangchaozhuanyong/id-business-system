<template>
  <section v-if="quote || requiresHuman" class="online-panel" aria-label="比特付款核对">
    <V2SectionHeading title="本次付款报价" />
    <dl v-if="quote" class="online-status-grid">
      <dt>账号</dt>
      <dd>{{ task.email || '当前任务账号' }}</dd>
      <dt>套餐</dt>
      <dd>{{ planName }}</dd>
      <dt>付款模式</dt>
      <dd>{{ quote.mode === 'automatic' ? '全自动付款' : '核对金额后付款' }}</dd>
      <dt>当次应付</dt>
      <dd>{{ money(quote.today) }}</dd>
      <dt>税费</dt>
      <dd>{{ money(quote.tax) }}</dd>
      <dt>每月续费</dt>
      <dd>{{ money(quote.renewal) }}</dd>
    </dl>
    <p v-if="task.paymentStarted">本次已提交付款，请等待或核对原单结果。</p>
    <p v-else-if="expired">报价已过期，请刷新任务后重新核对。</p>
    <p v-else-if="quote?.automatic">报价符合已保存的自动付款规则。</p>
    <p v-else-if="quote?.authorized">本次报价已确认，等待执行电脑继续处理。</p>
    <AppButton
      v-if="
        canManage &&
        task.status === 'running' &&
        !task.paymentStarted &&
        quote &&
        !quote.authorized &&
        !quote.automatic
      "
      variant="primary"
      :loading="busy"
      :disabled="expired"
      @click="confirm"
      >确认本次金额并付款</AppButton
    >
    <AppButton
      v-if="canManage && requiresHuman && task.status === 'running'"
      variant="soft"
      :loading="busy"
      @click="resume"
      >人工验证完成，继续处理</AppButton
    >
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { canUseOnlineAction } from './permissions';
import { bitbrowserApi } from './bitbrowser-api';
import { onlineLabel } from './labels';
import type { PublicTask } from './contracts';
interface QuoteMoney {
  amount: string;
  currency: string;
}
interface Quote {
  mode: 'manual' | 'automatic';
  automatic: boolean;
  authorized?: boolean;
  today: QuoteMoney;
  tax: QuoteMoney;
  renewal: QuoteMoney;
  digest: string;
  version: number;
  expiresAt: string;
}
const props = defineProps<{ task: PublicTask }>();
const emit = defineEmits<{ confirmed: [] }>();
const auth = useAuthStore();
const canManage = computed(() => canUseOnlineAction(auth.user, 'config', 'update'));
const quote = computed(() => props.task.result?.bitBrowserQuote as Quote | undefined);
const requiresHuman = computed(() => props.task.result?.bitBrowserUserAction === true);
const expired = computed(
  () => !quote.value || new Date(quote.value.expiresAt).getTime() <= Date.now()
);
const planName = computed(() => onlineLabel(props.task.plan));
const money = (value: QuoteMoney) => `${value.amount} ${value.currency}`;
const busy = ref(false),
  message = ref(''),
  failed = ref(false);
async function resume() {
  if (busy.value || !canManage.value) return;
  busy.value = true;
  try {
    await bitbrowserApi.resume(props.task.id);
    failed.value = false;
    message.value = '已通知执行电脑继续核对';
    emit('confirmed');
  } catch (error) {
    failed.value = true;
    message.value = getApiErrorMessage(error);
  } finally {
    busy.value = false;
  }
}
async function confirm() {
  if (!quote.value || busy.value || expired.value || !canManage.value) return;
  busy.value = true;
  try {
    await bitbrowserApi.confirm(props.task.id, quote.value.digest, quote.value.version);
    failed.value = false;
    message.value = '已确认本次报价，执行电脑将继续付款';
    emit('confirmed');
  } catch (error) {
    failed.value = true;
    message.value = getApiErrorMessage(error);
    emit('confirmed');
  } finally {
    busy.value = false;
  }
}
</script>
