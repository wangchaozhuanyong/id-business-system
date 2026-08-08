<template>
  <V2FinanceLedgerView v-bind="financeView" />
</template>

<script setup lang="ts">
import V2FinanceLedgerView from '../finance-ledger/V2FinanceLedgerView.vue';

const financeView = { moduleKey: 'finance-expenses' as const, expenseOnly: true };
</script>
