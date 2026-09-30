<template>
  <el-form-item label="付款币种" :prop="prop" required>
    <el-select v-model="value" filterable :aria-label="selectLabel" :loading="loading">
      <el-option
        v-for="item in currencies"
        :key="item.code"
        :label="`${item.code} · ${item.name}`"
        :value="item.code"
      />
    </el-select>
  </el-form-item>
</template>

<script setup lang="ts">
import type { BankRechargeCurrency } from './bank-recharge-api';

defineProps<{
  currencies: BankRechargeCurrency[];
  loading: boolean;
  selectLabel: string;
  prop?: string;
}>();
const value = defineModel<string>({ required: true });
</script>
