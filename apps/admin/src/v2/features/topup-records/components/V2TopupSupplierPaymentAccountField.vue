<template>
  <V2AsyncRegion
    variant="field"
    skeleton="control"
    :phase="query.phase.value"
    :error="error"
    loading-title="正在读取付款账户"
    error-title="付款账户加载失败"
    @retry="query.refresh"
  >
    <el-select
      :model-value="modelValue"
      placeholder="请选择启用的 USDT 账户"
      filterable
      @update:model-value="emit('update:modelValue', $event)"
    >
      <el-option
        v-for="account in accounts"
        :key="account.id"
        :label="`${account.name} · 余额 ${formatDecimal(account.currentBalance)} USDT`"
        :value="account.id"
      />
    </el-select>
    <span v-if="query.hasCurrentData.value && !accounts.length" class="v2-form-help"
      >请先在财务记账建立启用的 USDT 资金账户。</span
    >
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { idBusinessV2TopupSupplierFundsApi } from '../api';
import { formatSupplierFundDecimal as formatDecimal } from '../topup-supplier-fund-format';

const props = defineProps<{ modelValue: string; enabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const query = useV2ModuleQuery({
  moduleKey: 'topup-records',
  scope: 'finance-accounts',
  key: 'supplier-payment-accounts',
  enabled: () => props.enabled,
  keepPreviousData: true,
  query: ({ signal }) => idBusinessV2TopupSupplierFundsApi.listPaymentAccounts({ signal })
});
const accounts = computed(() => query.data.value?.items ?? []);
const error = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));
</script>
