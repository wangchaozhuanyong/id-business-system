<template>
  <el-form-item label="使用 ID" prop="accountId">
    <el-select
      v-model="accountId"
      filterable
      :remote="idSelectionMode === 'manual'"
      :reserve-keyword="idSelectionMode === 'manual'"
      :remote-method="(keyword: string) => $emit('search', keyword)"
      :loading="matchingLoading"
      :disabled="!canMatch"
      :placeholder="placeholder"
    >
      <el-option
        v-for="candidate in candidates"
        :key="candidate.id"
        :label="`${candidate.appleIdMasked} / 余额 ${formatDecimal(candidate.currentBalance)}`"
        :value="candidate.id"
      />
    </el-select>
  </el-form-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { V2OrderAccountSource, V2OrderCandidate } from '../contracts';

const props = defineProps<{
  accountSource: V2OrderAccountSource;
  idSelectionMode: 'auto' | 'manual';
  customerId: string;
  canMatch: boolean;
  matchingLoading: boolean;
  candidates: V2OrderCandidate[];
  formatDecimal: (value: string) => string;
}>();

defineEmits<{
  search: [keyword: string];
}>();

const accountId = defineModel<string>('accountId', { required: true });
const placeholder = computed(() => {
  if (props.accountSource === 'customer_owned') {
    return props.customerId ? '输入 Apple ID 或原销售订单号' : '请先选择客户';
  }
  return props.idSelectionMode === 'manual' ? '输入 Apple ID 搜索' : '等待自动匹配';
});
</script>
