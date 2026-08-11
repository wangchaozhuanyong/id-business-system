<template>
  <nav class="v2-analytics-navigation" aria-label="经营分析分区">
    <button
      v-for="section in sections"
      :key="section.key"
      type="button"
      :class="{ 'is-active': activeSection === section.key }"
      :aria-current="activeSection === section.key ? 'page' : undefined"
      @click="$emit('update:activeSection', section.key)"
    >
      <el-icon class="v2-analytics-navigation__icon"><component :is="section.icon" /></el-icon>
      <span class="v2-analytics-navigation__copy">
        <strong>{{ section.label }}</strong>
        <small>{{ section.description }}</small>
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { markRaw } from 'vue';
import { Coin, DataLine, DocumentChecked, Wallet } from '@element-plus/icons-vue';

export type AnalyticsSectionKey = 'profit' | 'cash-flow' | 'assets' | 'reconciliation';

defineProps<{ activeSection: AnalyticsSectionKey }>();
defineEmits<{ 'update:activeSection': [value: AnalyticsSectionKey] }>();

const sections = [
  { key: 'profit', label: '经营利润', description: '收入、成本与损益', icon: markRaw(DataLine) },
  { key: 'cash-flow', label: '资金收支', description: '四币种现金流', icon: markRaw(Coin) },
  { key: 'assets', label: '资产余额', description: '账面值与最新估值', icon: markRaw(Wallet) },
  {
    key: 'reconciliation',
    label: '账务对账',
    description: '流水与闭环问题',
    icon: markRaw(DocumentChecked)
  }
] satisfies Array<{
  key: AnalyticsSectionKey;
  label: string;
  description: string;
  icon: ReturnType<typeof markRaw>;
}>;
</script>
