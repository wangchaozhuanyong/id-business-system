<template>
  <el-select :model-value="modelValue" aria-label="优惠状况" @update:model-value="update">
    <el-option v-if="all" label="全部" value="all" />
    <el-option
      v-for="(label, value) in V2_ACCOUNT_OFFER_LABELS"
      :key="value"
      :label="label"
      :value="value"
    />
  </el-select>
</template>
<script setup lang="ts">
import { V2_ACCOUNT_OFFER_LABELS, type V2AccountOffer } from '@apple-business/shared';
defineProps<{ modelValue: V2AccountOffer | 'all'; all?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: V2AccountOffer | 'all'] }>();
function update(value: V2AccountOffer | 'all') {
  emit('update:modelValue', value);
}
</script>
