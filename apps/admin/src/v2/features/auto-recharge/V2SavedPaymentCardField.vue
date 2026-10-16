<template>
  <el-form-item label="共享银行卡" :aria-busy="detailLoading || undefined">
    <el-select
      :model-value="value"
      name="recharge-saved-card-entry"
      autocomplete="off"
      clearable
      filterable
      placeholder="选择当前套餐的银行卡"
      :loading="loading"
      @update:model-value="$emit('select', String($event ?? ''))"
    >
      <el-option
        v-for="card in cards"
        :key="card.id"
        :value="card.id"
        :label="`${card.label} · 尾号 ${card.last4}`"
      />
    </el-select>
    <AppButton
      v-if="cards.length"
      link
      :disabled="loading || detailLoading"
      @click="$emit('select', cards[0]!.id)"
      >智能分配</AppButton
    >
    <p v-if="!loading && !error && !cards.length" class="recharge-note">
      当前套餐暂无可用银行卡，请先在银行卡共享池配置。
    </p>
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
import type { SharedPaymentCard } from './bank-recharge-api';

defineProps<{
  value: string;
  cards: SharedPaymentCard[];
  loading: boolean;
  detailLoading?: boolean;
  error: unknown;
}>();
defineEmits<{ select: [id: string]; retry: [] }>();
</script>
