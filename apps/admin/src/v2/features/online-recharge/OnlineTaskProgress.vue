<template>
  <section v-if="task" class="online-panel">
    <V2SectionHeading title="执行进度"
      ><template #actions
        ><span>{{ connected ? '实时连接正常' : '正在查询进度' }}</span
        ><AppButton variant="soft" @click="$emit('refresh')">刷新结果</AppButton></template
      ></V2SectionHeading
    >
    <dl class="online-status-grid">
      <dt>任务编号</dt>
      <dd class="online-wrap">{{ task.id }}</dd>
      <dt>执行状态</dt>
      <dd>{{ onlineLabel(task.status) }}</dd>
      <dt>目标套餐</dt>
      <dd>{{ onlineLabel(task.plan) }}</dd>
      <template v-if="task.planRegion">
        <dt>代理国家</dt>
        <dd>{{ proxyCountryLabel(task.planRegion.proxyCountryCode) }}</dd>
        <dt>支付地区</dt>
        <dd>{{ proxyCountryLabel(task.planRegion.paymentRegion) }}</dd>
        <dt>预期结算币种</dt>
        <dd>{{ task.planRegion.expectedCurrency }}</dd>
        <dt>地区规则版本</dt>
        <dd>{{ task.planRegion.configVersion }}</dd>
      </template>
      <dt>完成进度</dt>
      <dd>{{ task.progress ?? 0 }}%</dd>
      <dt>执行说明</dt>
      <dd class="online-wrap">{{ task.message || '等待执行器更新' }}</dd>
    </dl>
    <el-progress
      :percentage="Math.min(100, Math.max(0, Number(task.progress ?? 0)))"
      :show-text="false"
    />
    <p v-if="error" role="alert" class="online-error">{{ error }}</p>
    <p v-if="task.status === 'awaiting_review'">
      原单结果待核对，请保留当前任务和兑换码，使用原任务核对，不要重新付款。
    </p>
    <dl v-if="changeEntries.length" class="online-status-grid">
      <template v-for="entry in changeEntries" :key="entry.label"
        ><dt>{{ entry.label }}</dt>
        <dd class="online-wrap">{{ entry.value }}</dd></template
      >
    </dl>
    <dl v-if="results.length" class="online-status-grid">
      <template v-for="entry in results" :key="entry.label"
        ><dt>{{ entry.label }}</dt>
        <dd class="online-wrap">{{ entry.value }}</dd></template
      >
    </dl>
    <a v-if="billingUrl" :href="billingUrl" target="_blank" rel="noopener noreferrer"
      >打开账单管理</a
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { proxyCountryLabel } from '@/v2/features/proxy-pool/public-api';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { PublicTask } from './contracts';
import { onlineChangeEntries, onlineLabel, onlineSubscriptionDetails } from './labels';
const props = defineProps<{ task?: PublicTask; connected?: boolean; error?: string }>();
defineEmits<{ refresh: [] }>();
const labels: Record<string, string> = {
  subscriptionStatus: '订阅状态',
  hasActiveSubscription: '有效订阅',
  plan: '订阅套餐',
  expiresAt: '到期时间',
  autoRenew: '自动续费',
  remainingDaysDisplay: '剩余时长',
  subscriptionChannel: '订阅渠道',
  currency: '币种',
  queriedAtDisplay: '查询时间',
  emailMasked: '账号',
  renewalStatus: '续费处理',
  invoiceHint: '发票指引',
  message: '结果说明',
  checkoutUrl: '支付链接',
  error: '查询结果说明'
};
const details = computed(() =>
  onlineSubscriptionDetails(
    ['queued', 'running'].includes(props.task?.status ?? '') ? undefined : props.task?.result
  )
);
const changeEntries = computed(() =>
  onlineChangeEntries({
    subscriptionChange: props.task?.subscriptionChange
  })
);
const results = computed(() =>
  Object.entries(details.value)
    .filter(([key]) => labels[key])
    .map(([key, value]) => ({
      label: labels[key],
      value: [
        'subscriptionStatus',
        'plan',
        'renewalStatus',
        'autoRenew',
        'hasActiveSubscription'
      ].includes(key)
        ? onlineLabel(value)
        : String(value ?? '—')
    }))
);
const billingUrl = computed(() => {
  const value = String(details.value.billingUrl ?? details.value.billingPageUrl ?? '');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['chatgpt.com', 'pay.openai.com', 'billing.stripe.com'].includes(url.hostname)
      ? url.toString()
      : '';
  } catch {
    return '';
  }
});
</script>
