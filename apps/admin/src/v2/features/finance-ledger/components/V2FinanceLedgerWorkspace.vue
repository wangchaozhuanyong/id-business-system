<template>
  <V2FinanceAccountsList v-if="page.activeTab === 'accounts'" :page="page" />
  <V2FinanceWalletsList v-else-if="page.activeTab === 'wallets'" :page="page" />
  <V2FinanceJournalsList v-else-if="page.activeTab === 'journals'" :page="page" />
  <V2FinancePeriodsList v-else-if="page.activeTab === 'periods'" :page="page" />
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import V2FinanceAccountsList from './V2FinanceAccountsList.vue';
import V2FinanceJournalsList from './V2FinanceJournalsList.vue';
import V2FinancePeriodsList from './V2FinancePeriodsList.vue';
import V2FinanceWalletsList from './V2FinanceWalletsList.vue';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
