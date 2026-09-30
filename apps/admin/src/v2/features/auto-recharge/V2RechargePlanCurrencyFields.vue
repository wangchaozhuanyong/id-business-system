<template>
  <el-form-item label="开通套餐" required>
    <el-select
      :model-value="plan"
      aria-label="选择开通套餐"
      @update:model-value="$emit('update:plan', $event)"
    >
      <el-option
        v-for="item in V2_RECHARGE_PLANS"
        :key="item"
        :label="planLabels[item]"
        :value="item"
      />
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
    {{ error }} <el-button link type="primary" @click="$emit('retry')">重试</el-button>
  </p>
</template>

<script setup lang="ts">
import { V2_RECHARGE_PLANS } from '@apple-business/shared';
import type { V2RechargePlan } from './contracts';
import { planLabels } from './recharge-presentation';

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
