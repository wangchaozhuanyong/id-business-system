<template>
  <el-select
    :model-value="modelValue"
    :title="selectedCustomerLabel"
    filterable
    remote
    reserve-keyword
    remote-show-suffix
    :suffix-icon="Search"
    :remote-method="remoteMethod"
    :disabled="disabled"
    :no-match-text="emptyText"
    :no-data-text="emptyText"
    placeholder="按名称、手机、微信、QQ、WhatsApp 搜索"
    @update:model-value="updateModelValue"
  >
    <el-option
      v-for="customer in customers"
      :key="customer.id"
      :label="formatV2CustomerSearchLabel(customer, keyword)"
      :value="customer.id"
    />
    <template #footer>
      <el-text size="small" type="info">
        {{
          searching
            ? '正在按关键词匹配客户…'
            : keyword
              ? '搜索结果最多显示 50 条，请继续输入更精确关键词'
              : '支持名称、手机、微信、QQ、WhatsApp 关键词搜索'
        }}
      </el-text>
    </template>
  </el-select>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { formatV2CustomerSearchLabel } from '@/v2/utils/customerSearch';
import type { V2OrderEntryCustomer } from '../contracts';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    customers: V2OrderEntryCustomer[];
    keyword: string;
    searching?: boolean;
    disabled?: boolean;
    remoteMethod: (keyword: string) => unknown;
  }>(),
  { disabled: false, searching: false }
);

const emptyText = computed(() => (props.searching ? '正在搜索客户…' : '未找到匹配客户'));
const selectedCustomerLabel = computed(() => {
  const selectedCustomer = props.customers.find((customer) => customer.id === props.modelValue);
  return selectedCustomer ? formatV2CustomerSearchLabel(selectedCustomer) : undefined;
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

function updateModelValue(value: unknown) {
  emit('update:modelValue', typeof value === 'string' ? value : '');
}
</script>
