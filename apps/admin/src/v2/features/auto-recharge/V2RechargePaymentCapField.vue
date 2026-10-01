<template>
  <el-form-item label="付款安全上限">
    <div class="recharge-cap-control">
      <span :title="current ? `${current.maxAmount} ${currencyCode}` : '尚未配置'">{{
        current ? `${current.maxAmount} ${currencyCode}` : '尚未配置'
      }}</span>
      <el-button link type="primary" aria-label="设置上限" @click="open = true">设置</el-button>
    </div>
  </el-form-item>
  <V2RechargePaymentCapDrawer
    v-if="open"
    v-model="open"
    :plan="plan"
    :currency-code="currencyCode"
    :caps="caps"
    :phase="phase"
    :load-error="loadError"
    @retry="$emit('refresh')"
    @saved="$emit('refresh')"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import type { V2RechargePaymentCap, V2RechargePlan } from './contracts';
import V2RechargePaymentCapDrawer from './V2RechargePaymentCapDrawer.vue';

const props = defineProps<{
  plan: V2RechargePlan;
  currencyCode: string;
  caps: V2RechargePaymentCap[];
  phase: V2QueryPhase;
  loadError: string;
}>();
defineEmits<{ refresh: [] }>();
const open = ref(false);
const current = computed(() =>
  props.caps.find((item) => item.plan === props.plan && item.currencyCode === props.currencyCode)
);
</script>

<style scoped>
.recharge-cap-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
  font-size: 13px;
  line-height: 20px;
}
.recharge-cap-control > span {
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.recharge-cap-control :deep(.el-button) {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  font-size: 12px;
}
@media (max-width: 900px) {
  .recharge-cap-control {
    min-height: 44px;
  }
}
</style>
