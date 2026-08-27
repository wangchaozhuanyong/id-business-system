<template>
  <nav class="v2-finance-cashbook-navigation" aria-label="收支记录类型">
    <button
      type="button"
      :class="{ 'is-active': page.cashbookView === 'inflows' }"
      :aria-current="page.cashbookView === 'inflows' ? 'page' : undefined"
      @click="page.cashbookView = 'inflows'"
    >
      <span>收入记录</span>
      <small>经营收入、股东投入、借入资金</small>
      <strong>{{ page.inflowTotal }}</strong>
    </button>
    <button
      type="button"
      :class="{ 'is-active': page.cashbookView === 'expenses' }"
      :aria-current="page.cashbookView === 'expenses' ? 'page' : undefined"
      @click="page.cashbookView = 'expenses'"
    >
      <span>开支记录</span>
      <small>日常经营开支与更正记录</small>
      <strong>{{ page.expenseTotal }}</strong>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
