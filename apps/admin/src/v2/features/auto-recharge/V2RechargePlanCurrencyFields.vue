<template>
  <el-form-item label="开通套餐" required>
    <el-select
      :model-value="plan"
      aria-label="选择开通套餐"
      @update:model-value="$emit('update:plan', $event)"
    >
      <el-option
        v-for="item in rechargePlanOptions"
        :key="item.value"
        class="recharge-plan-option"
        :label="item.label"
        :value="item.value"
        :disabled="item.disabled"
        :title="item.note ? `${item.label}：${item.note}` : item.label"
      >
        <span class="recharge-plan-option__label">{{ item.label }}</span>
        <small v-if="item.note" class="recharge-plan-option__note">{{ item.note }}</small>
      </el-option>
    </el-select>
  </el-form-item>
  <el-form-item label="锁定币种" required>
    <el-select
      :model-value="currency"
      aria-label="选择锁定币种"
      filterable
      @update:model-value="$emit('update:currency', $event)"
    >
      <el-option
        v-for="item in currencies"
        :key="item.value"
        :label="item.label"
        :value="item.value"
      />
    </el-select>
  </el-form-item>
  <p v-if="error" class="recharge-error" role="alert">
    {{ error }} <AppButton link variant="primary" @click="$emit('retry')">重试</AppButton>
  </p>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RechargePlan } from './contracts';
import { rechargePlanOptions } from './recharge-plan-options';

defineProps<{
  plan: V2RechargePlan;
  currency: string;
  currencies: { value: string; label: string }[];
  error: string;
}>();
defineEmits<{
  'update:plan': [value: V2RechargePlan];
  'update:currency': [value: string];
  retry: [];
}>();
</script>

<style scoped>
.recharge-plan-option {
  height: auto;
  min-height: 34px;
  padding-top: 6px;
  padding-bottom: 6px;
  line-height: 20px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.recharge-plan-option__label,
.recharge-plan-option__note {
  display: block;
}

.recharge-plan-option__note {
  font-size: 12px;
  font-weight: normal;
}
</style>
