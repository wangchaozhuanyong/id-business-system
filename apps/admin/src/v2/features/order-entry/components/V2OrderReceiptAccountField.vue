<template>
  <el-form-item
    label="收款账户"
    prop="receivedFinanceAccountId"
    :required="required"
    :error="error"
  >
    <el-select
      v-model="selectedId"
      filterable
      clearable
      :disabled="disabled"
      :placeholder="disabled ? '原订单未记录收款账户' : `请选择 ${currency} 收款账户`"
      aria-label="订单收款账户"
    >
      <el-option
        v-for="account in choices"
        :key="account.value"
        :label="account.label"
        :value="account.value"
        :disabled="account.disabled"
      />
    </el-select>
  </el-form-item>
</template>

<script setup lang="ts">
import type { V2FinanceCurrency } from '@apple-business/shared';

withDefaults(
  defineProps<{
    choices: Array<{ value: string; label: string; disabled: boolean }>;
    required: boolean;
    error: string;
    currency?: V2FinanceCurrency;
    disabled?: boolean;
  }>(),
  { currency: 'CNY', disabled: false }
);

const selectedId = defineModel<string>({ required: true });
</script>
