<template>
  <el-form-item label="目标/反算利润率" prop="targetProfitRate">
    <div class="v2-order-profit-rate-control">
      <el-input
        :model-value="modelValue"
        clearable
        inputmode="decimal"
        maxlength="12"
        :placeholder="mode === 'receipt' ? '填写原币实收后自动反算' : '选填，例如 10'"
        @update:model-value="emit('update:modelValue', String($event ?? ''))"
      >
        <template #append>%</template>
      </el-input>
      <small role="status" aria-live="polite">{{ hint }}</small>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import type { OrderPricingInputMode } from '../useOrderPricingInputMode';

defineProps<{
  modelValue: string;
  mode: OrderPricingInputMode;
  hint: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<style scoped>
.v2-order-profit-rate-control {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 4px;
}

.v2-order-profit-rate-control :deep(.el-input__inner) {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.v2-order-profit-rate-control small {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.35;
}
</style>
