<template>
  <section class="v2-finance-page" :class="{ 'v2-finance-page--ledger': !page.expenseOnly }">
    <template v-if="page.expenseOnly">
      <V2AsyncRegion
        skeleton="table"
        :phase="page.queryPhase"
        :previous-data="page.isParameterTransition"
        :error="page.error"
        loading-title="正在加载收支记录"
        refreshing-title="正在更新收支记录"
        error-title="收支记录加载失败"
        @retry="page.refresh"
      >
        <div class="v2-finance-expenses-page">
          <V2FinanceExpensesOverview :page="page" />

          <el-alert
            v-if="page.settings?.historyStatus !== 'completed'"
            type="warning"
            title="生命周期利润仍不完整"
            :description="page.settings?.historyNote || '请先回填历史，再确认期初余额与旧开支。'"
            show-icon
            :closable="false"
          />

          <V2FinanceCashbookNavigation :page="page" />
          <V2FinanceExpensesToolbar :page="page" />
          <V2FinanceInflowsTable v-if="page.cashbookView === 'inflows'" :page="page" />
          <V2FinanceExpensesTable v-else :page="page" />
        </div>
      </V2AsyncRegion>
    </template>

    <V2AsyncRegion
      v-else
      skeleton="table"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.error"
      loading-title="正在加载钱包账户"
      refreshing-title="正在更新钱包账户"
      error-title="钱包账户加载失败"
      @retry="page.refresh"
    >
      <div class="v2-finance-ledger-page">
        <V2FinanceLedgerOverview :page="page" />

        <el-alert
          v-if="page.settings?.historyStatus !== 'completed'"
          type="warning"
          title="生命周期利润仍不完整"
          :description="page.settings?.historyNote || '请先回填历史，再确认期初余额与旧开支。'"
          show-icon
          :closable="false"
        />

        <V2FinanceLedgerNavigation :page="page" />
        <V2FinanceLedgerToolbar :page="page" />
        <V2FinanceLedgerWorkspace :page="page" />
      </div>
    </V2AsyncRegion>

    <V2FinanceLedgerDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { V2ModuleKey } from '@/v2/features/feature';
import V2FinanceExpensesOverview from './components/V2FinanceExpensesOverview.vue';
import V2FinanceCashbookNavigation from './components/V2FinanceCashbookNavigation.vue';
import V2FinanceExpensesTable from './components/V2FinanceExpensesTable.vue';
import V2FinanceExpensesToolbar from './components/V2FinanceExpensesToolbar.vue';
import V2FinanceInflowsTable from './components/V2FinanceInflowsTable.vue';
import V2FinanceLedgerDrawers from './components/V2FinanceLedgerDrawers.vue';
import V2FinanceLedgerNavigation from './components/V2FinanceLedgerNavigation.vue';
import V2FinanceLedgerOverview from './components/V2FinanceLedgerOverview.vue';
import V2FinanceLedgerToolbar from './components/V2FinanceLedgerToolbar.vue';
import V2FinanceLedgerWorkspace from './components/V2FinanceLedgerWorkspace.vue';
import { useFinanceLedgerPage } from './useFinanceLedgerPage';
import '@/v2/styles/records.css';
import '@/v2/styles/finance.css';

const props = withDefaults(
  defineProps<{
    moduleKey?: Extract<V2ModuleKey, 'finance-ledger' | 'finance-expenses'>;
    expenseOnly?: boolean;
  }>(),
  { moduleKey: 'finance-ledger', expenseOnly: false }
);
const page = reactive(useFinanceLedgerPage(props.moduleKey, props.expenseOnly));
</script>
