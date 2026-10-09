<template>
  <el-form-item label="已保存银行卡" :aria-busy="detailLoading || undefined">
    <el-select
      :model-value="value"
      name="recharge-saved-card-entry"
      autocomplete="off"
      clearable
      filterable
      placeholder="选择银行卡（可选）"
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
    <p v-if="detailLoading" class="recharge-note" role="status">正在读取银行卡资料，请稍候。</p>
    <p v-if="error" class="recharge-error" role="alert">
      {{ getApiErrorMessage(error) }}
      <AppButton link variant="primary" @click="$emit('retry')">重试</AppButton>
    </p>
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import type { BankRechargeCard } from './bank-recharge-api';

defineProps<{
  value: string;
  cards: BankRechargeCard[];
  loading: boolean;
  detailLoading?: boolean;
  error: unknown;
}>();
defineEmits<{ select: [id: string]; retry: [] }>();
</script>
