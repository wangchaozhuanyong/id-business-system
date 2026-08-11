<template>
  <nav class="v2-finance-ledger-navigation" aria-label="钱包账户业务分类">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :class="{ 'is-active': page.activeTab === item.key }"
      :aria-current="page.activeTab === item.key ? 'page' : undefined"
      @click="page.activeTab = item.key"
    >
      <span class="v2-finance-ledger-navigation__icon" aria-hidden="true">
        <el-icon><component :is="item.icon" /></el-icon>
      </span>
      <span class="v2-finance-ledger-navigation__copy">
        <strong>{{ item.label }}</strong>
        <small>{{ item.description }}</small>
      </span>
      <span class="v2-finance-ledger-navigation__count">{{ item.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Calendar, CreditCard, Tickets, Wallet } from '@element-plus/icons-vue';
import type { FinanceLedgerTab, useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const items = computed<
  Array<{
    key: Extract<FinanceLedgerTab, 'accounts' | 'wallets' | 'journals' | 'periods'>;
    label: string;
    description: string;
    count: number;
    icon: typeof CreditCard;
  }>
>(() => [
  {
    key: 'accounts',
    label: '资金账户',
    description: '银行卡、现金与自有钱包',
    count: props.page.accounts.length,
    icon: markRaw(CreditCard)
  },
  {
    key: 'wallets',
    label: '供应商钱包',
    description: '供应商预付与退款余额',
    count: props.page.wallets.length,
    icon: markRaw(Wallet)
  },
  {
    key: 'journals',
    label: '不可变流水',
    description: '借贷明细与冲销记录',
    count: props.page.journalTotal,
    icon: markRaw(Tickets)
  },
  {
    key: 'periods',
    label: '关账与历史',
    description: '历史基线与月度关账',
    count: props.page.periods.length,
    icon: markRaw(Calendar)
  }
]);
</script>
