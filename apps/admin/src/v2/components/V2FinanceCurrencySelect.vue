<template>
  <el-select
    :model-value="modelValue"
    filterable
    :clearable="clearable"
    :disabled="disabled"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    @update:model-value="$emit('update:modelValue', $event)"
    @change="$emit('change', $event)"
  >
    <el-option
      v-for="item in V2_FINANCE_CURRENCY_OPTIONS"
      :key="item.code"
      :label="item.label"
      :value="item.code"
    />
  </el-select>
</template>
<script setup lang="ts">
import { V2_FINANCE_CURRENCY_OPTIONS } from '@apple-business/shared';
withDefaults(
  defineProps<{
    modelValue: string;
    clearable?: boolean;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
  }>(),
  { clearable: false, disabled: false, placeholder: '请选择币种', ariaLabel: '选择财务币种' }
);
defineEmits<{ 'update:modelValue': [value: string]; change: [value: string] }>();
</script>
