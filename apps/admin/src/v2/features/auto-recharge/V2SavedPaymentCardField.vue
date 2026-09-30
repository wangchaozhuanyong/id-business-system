<template>
  <el-form-item label="已保存银行卡">
    <el-select
      :model-value="value"
      clearable
      filterable
      placeholder="选择银行卡，或在下方手动输入"
      :loading="loading"
      @update:model-value="$emit('select', String($event ?? ''))"
    >
      <el-option
        v-for="card in cards"
        :key="card.id"
        :value="card.id"
        :label="`${card.label} · 尾号 ${card.last4} · ${card.currencyCode}`"
      />
    </el-select>
    <p v-if="error" class="recharge-error" role="alert">
      {{ getApiErrorMessage(error) }}
      <el-button link type="primary" @click="$emit('retry')">重试</el-button>
    </p>
  </el-form-item>
</template>

<script setup lang="ts">
import { getApiErrorMessage } from '@/api/client';
import type { BankRechargeCard } from './bank-recharge-api';

defineProps<{
  value: string;
  cards: BankRechargeCard[];
  loading: boolean;
  error: unknown;
}>();
defineEmits<{ select: [id: string]; retry: [] }>();
</script>
