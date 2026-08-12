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

  <el-form-item v-if="accountSource === 'inventory'" label="ID 选择方式">
    <el-radio-group
      v-model="idSelectionMode"
      class="v2-order-entry-selection-mode"
      @change="$emit('selection-mode-change', $event)"
    >
      <el-radio value="auto">自动匹配</el-radio>
      <el-radio value="manual">手动选择</el-radio>
    </el-radio-group>
  </el-form-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { V2OrderAccountSource, V2OrderCandidate } from '../contracts';

const props = defineProps<{
  accountSource: V2OrderAccountSource;
  customerId: string;
  canMatch: boolean;
  matchingLoading: boolean;
  candidates: V2OrderCandidate[];
  formatDecimal: (value: string) => string;
}>();

defineEmits<{
  search: [keyword: string];
  'selection-mode-change': [value: unknown];
}>();

const accountId = defineModel<string>('accountId', { required: true });
const idSelectionMode = defineModel<'auto' | 'manual'>('idSelectionMode', { required: true });
const placeholder = computed(() => {
  if (props.accountSource === 'customer_owned') {
    return props.customerId ? '输入 Apple ID 或原销售订单号' : '请先选择客户';
  }
  return idSelectionMode.value === 'manual' ? '输入 Apple ID 搜索' : '等待自动匹配';
});
</script>
