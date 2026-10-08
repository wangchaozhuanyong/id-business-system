<template>
  <section
    v-if="confirmation.eligible.value"
    class="recharge-local-confirmation"
    aria-label="本次付款确认"
  >
    <p>请核对当前账号、目标套餐和官网今日应付。确认仅用于当前报价；报价变化后本次确认失效。</p>
    <p v-if="confirmation.expiresAt.value">
      本次确认有效至 {{ formatV2DateTime(confirmation.expiresAt.value) }}
    </p>
    <p v-if="confirmation.message.value" role="status">{{ confirmation.message.value }}</p>
    <AppButton
      variant="primary"
      :disabled="!confirmation.confirmationEnabled.value"
      :loading="confirmation.busy.value"
      @click="confirmation.confirm"
      >确认本次报价并付款</AppButton
    >
    <AppButton
      :loading="confirmation.loading.value"
      :disabled="confirmation.busy.value"
      @click="confirmation.readConfirmation"
      >刷新本机确认状态</AppButton
    >
  </section>
</template>
<script setup lang="ts">
import { toRef } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RechargeJob } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { useRechargeLocalConfirmation } from './useRechargeLocalConfirmation';
const props = defineProps<{ job?: V2RechargeJob }>();
const emit = defineEmits<{ refresh: [] }>();
const confirmation = useRechargeLocalConfirmation(toRef(props, 'job'), () => emit('refresh'));
</script>
<style scoped>
.recharge-local-confirmation {
  width: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px;
}
.recharge-local-confirmation p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
