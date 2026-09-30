<template>
  <el-form-item label="付款安全上限">
    <span>{{ current ? `${current.maxAmount} ${currencyCode}` : '尚未配置' }}</span>
    <el-button link type="primary" @click="open = true">设置上限</el-button>
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
