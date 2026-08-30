<template>
  <nav class="v2-finance-cashbook-navigation" aria-label="收支记录类型">
    <button
      type="button"
      :class="{ 'is-active': page.cashbookView === 'inflows' }"
      :aria-current="page.cashbookView === 'inflows' ? 'page' : undefined"
      :aria-pressed="page.cashbookView === 'inflows'"
      @click="page.cashbookView = 'inflows'"
    >
      <span class="v2-finance-cashbook-navigation__icon" aria-hidden="true">
        <el-icon><BottomLeft /></el-icon>
      </span>
      <span class="v2-finance-cashbook-navigation__copy">
        <strong>收入记录</strong>
        <small>经营收入、股东投入、借入资金</small>
      </span>
      <span class="v2-finance-cashbook-navigation__count">
        <strong>{{ page.inflowTotal }}</strong>
        <small>条</small>
      </span>
    </button>
    <button
      type="button"
      :class="{ 'is-active': page.cashbookView === 'expenses' }"
      :aria-current="page.cashbookView === 'expenses' ? 'page' : undefined"
      :aria-pressed="page.cashbookView === 'expenses'"
      @click="page.cashbookView = 'expenses'"
    >
      <span class="v2-finance-cashbook-navigation__icon" aria-hidden="true">
        <el-icon><TopRight /></el-icon>
      </span>
      <span class="v2-finance-cashbook-navigation__copy">
        <strong>开支记录</strong>
        <small>日常经营开支与更正记录</small>
      </span>
      <span class="v2-finance-cashbook-navigation__count">
        <strong>{{ page.expenseTotal }}</strong>
        <small>条</small>
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { BottomLeft, TopRight } from '@element-plus/icons-vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
