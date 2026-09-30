<template>
  <V2FormDrawer
    :model-value="modelValue"
    title="服务器付款安全上限"
    description="每个套餐和币种配置一次；未配置时禁止自动付款。"
    confirm-text="保存上限"
    :confirm-loading="saving"
    :confirm-disabled-reason="disabledReason"
    :dirty="amount !== (existing?.maxAmount ?? '')"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="save"
  >
    <V2AsyncRegion
      variant="section"
      skeleton="form"
      :phase="phase"
      :error="loadError"
      loading-title="正在读取付款安全上限"
      @retry="$emit('retry')"
    >
      <el-form label-position="left" label-width="116px" require-asterisk-position="right">
        <el-form-item label="套餐"
          ><span>{{ planLabels[plan] }}</span></el-form-item
        >
        <el-form-item label="币种"
          ><span>{{ currencyCode }}</span></el-form-item
        >
        <el-form-item label="付款安全上限" required>
          <el-input v-model="amount" inputmode="decimal" maxlength="12" aria-label="付款安全上限">
            <template #append>{{ currencyCode }}</template>
          </el-input>
        </el-form-item>
      </el-form>
      <p class="recharge-note">官网最终今日应付高于此金额时，本次任务会停止，不提交付款。</p>
      <p v-if="saveError" class="recharge-error" role="alert">{{ saveError }}</p>
    </V2AsyncRegion>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { V2RechargePaymentCap, V2RechargePlan } from './contracts';
import { getApiErrorMessage } from '@/api/client';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import { rechargeApi } from './api';
import { planLabels } from './recharge-presentation';

const props = defineProps<{
  modelValue: boolean;
  plan: V2RechargePlan;
  currencyCode: string;
  caps: V2RechargePaymentCap[];
  phase: V2QueryPhase;
  loadError: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
  retry: [];
}>();
const amount = ref('');
const saving = ref(false);
const saveError = ref('');
const existing = computed(() =>
  props.caps.find((item) => item.plan === props.plan && item.currencyCode === props.currencyCode)
);
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      amount.value = existing.value?.maxAmount ?? '';
      saveError.value = '';
    }
  }
);
watch(existing, (value) => {
  if (props.modelValue && !amount.value) amount.value = value?.maxAmount ?? '';
});
const disabledReason = computed(() =>
  props.phase !== 'ready'
    ? '请先读取当前上限'
    : !/^[0-9]{1,9}(?:\.[0-9]{1,2})?$/.test(amount.value) || !/[1-9]/.test(amount.value)
      ? '请输入大于零的有效金额'
      : ''
);
async function save() {
  if (disabledReason.value || saving.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await rechargeApi.updatePaymentCap(props.plan, props.currencyCode, amount.value);
    emit('saved');
    emit('update:modelValue', false);
  } catch (cause) {
    saveError.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
