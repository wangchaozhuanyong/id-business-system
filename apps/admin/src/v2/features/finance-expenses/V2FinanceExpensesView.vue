<template>
  <V2FinanceLedgerView v-bind="financeView" />
</template>

<script setup lang="ts">
import { V2FinanceLedgerView } from '../finance-ledger/public-api';

const financeView = { moduleKey: 'finance-expenses' as const, expenseOnly: true };
</script>
