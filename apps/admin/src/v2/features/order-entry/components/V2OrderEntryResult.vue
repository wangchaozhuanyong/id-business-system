<template>
  <section
    v-if="createdResult"
    class="v2-order-entry-result"
    :class="{ 'v2-order-entry-result--pending': !consumptionResult }"
    aria-live="polite"
  >
    <div>
      <span>已保存订单</span>
      <strong>{{ createdResult.order.orderNo }}</strong>
    </div>
    <div>
      <span>使用 ID</span>
      <strong>{{ createdResult.order.account?.appleIdMasked || '-' }}</strong>
    </div>
    <div>
      <span>余额成本</span>
      <strong>{{
        consumptionResult ? `¥${formatDecimal(consumptionResult.order.balanceCostAmount)}` : '-'
      }}</strong>
    </div>
    <div>
      <span>当前状态</span>
      <strong>{{ consumptionResult ? '已扣余额，待开通记录' : '余额未扣减' }}</strong>
    </div>
    <div v-if="consumptionResult">
      <span>订单利润</span>
      <strong>¥{{ formatDecimal(consumptionResult.order.profitAmount || '0') }}</strong>
    </div>
    <AppButton
      v-if="hasPendingConsumption"
      variant="primary"
      :loading="consuming"
      @click="$emit('retry')"
    >
      重新扣减
    </AppButton>
    <AppButton variant="ghost" @click="$emit('viewOrders')">查看订单</AppButton>
  </section>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { ConsumeV2OrderResult, CreateV2OrderResult } from '../contracts';

defineProps<{
  createdResult: CreateV2OrderResult | null;
  consumptionResult: ConsumeV2OrderResult | null;
  hasPendingConsumption: boolean;
  consuming: boolean;
  formatDecimal: (value: string) => string;
}>();

defineEmits<{
  retry: [];
  viewOrders: [];
}>();
</script>
