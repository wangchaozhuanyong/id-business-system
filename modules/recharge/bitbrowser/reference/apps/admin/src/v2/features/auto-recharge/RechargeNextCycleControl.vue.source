<template>
  <section
    v-if="apiSupportsCycle && cycle.review.value?.protocol === 1"
    class="recharge-next-cycle-control"
    aria-label="旧订阅周期核实"
  >
    <p class="recharge-note" role="status">{{ cycleMessage }}</p>
    <p v-if="cycle.review.value.previousPeriodEnd" class="recharge-note">
      旧周期结束时间：{{ formatV2DateTime(cycle.review.value.previousPeriodEnd) }}
    </p>
    <template v-if="cycle.candidate.value">
      <p class="recharge-note">
        本次核实有效至 {{ formatV2DateTime(cycle.review.value.expiresAt) }}。
        请只确认旧周期已经结束；新充值仍会等待你核对官网报价并确认付款。
      </p>
      <V2AsyncRegion
        :phase="cycle.capabilityQuery.phase.value"
        :error="
          cycle.capabilityQuery.error.value
            ? getApiErrorMessage(cycle.capabilityQuery.error.value)
            : ''
        "
        loading-title="正在核对原任务助手能力"
        skeleton="form"
        @retry="cycle.capabilityQuery.refresh"
      >
        <AppButton
          v-if="cycle.supported.value"
          variant="primary"
          :disabled="!cycle.canOpen.value"
          @click="cycle.open"
          >核实旧周期已结束</AppButton
        >
        <p v-else class="recharge-note" role="status">
          当前本机助手尚未确认支持旧周期核实，请更新助手后刷新原任务。
        </p>
      </V2AsyncRegion>
    </template>
    <p v-if="cycle.message.value" class="recharge-note" role="status">{{ cycle.message.value }}</p>
    <V2ConfirmDialog
      v-model="cycle.dialogOpen.value"
      title="核实旧订阅周期"
      message=""
      confirm-text="确认旧周期已结束"
      :confirm-loading="cycle.busy.value"
      :confirm-disabled="cycle.confirmationBlocked.value"
      :retain-draft="false"
      @confirm="cycle.confirm"
    >
      <p>请根据原账号的订阅记录，确认上一个已付款周期已经结束。</p>
      <p>
        本次只提交旧周期事实，不授权扣款。助手会再次核对当前订阅和付款记录，后续付款仍须单独确认官网报价。
      </p>
      <p v-if="cycle.message.value" class="recharge-note" role="status">
        {{ cycle.message.value }}
      </p>
    </V2ConfirmDialog>
  </section>
</template>
<script setup lang="ts">
import { computed, toRef } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import type { V2RechargeJob } from './contracts';
import { useRechargeNextCycle } from './useRechargeNextCycle';
const props = defineProps<{ job?: V2RechargeJob; apiSupportsCycle: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const cycle = useRechargeNextCycle(toRef(props, 'job'), toRef(props, 'apiSupportsCycle'), () =>
  emit('refresh')
);
const cycleMessage = computed(() => {
  const review = cycle.review.value;
  if (review?.status === 'ready')
    return '旧周期核实已完成，助手正在重新核对当前订阅；本次尚未授权付款。';
  if (review?.status === 'consumed')
    return '本次已进入新订阅周期，历史付款记录保留；付款仍以本次官网报价确认结果为准。';
  if (review?.status === 'revoked') return '订阅状态或核实有效期已变化，请刷新原任务重新核对。';
  if (cycle.expired.value) return '本次旧周期核实已过期，请刷新原任务重新核对；尚未授权本次付款。';
  return '官网已核实当前没有有效订阅，旧周期的结束事实仍需本人核实；当前仅进行只读核对。';
});
</script>
<style scoped src="./auto-recharge.css"></style>
