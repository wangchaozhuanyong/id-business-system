<template>
  <V2PageOverview
    class="v2-finance-expenses-overview"
    aria-label="收支记账概览"
    title="收支记账总览"
    help="收入与开支统一留痕，区分经营收入、股东投入和借入资金，避免虚增利润。"
    metrics-label="当前收支指标"
  >
    <template #metrics>
      <V2OverviewMetric label="收入记录" :value="page.inflowTotal" note="当前收入筛选总数" />
      <V2OverviewMetric label="开支记录" :value="page.expenseTotal" note="当前开支筛选总数" />
      <V2OverviewMetric
        label="经营收入"
        :value="formatCny(page.inflowSummary.operatingIncomeCny)"
        note="计入经营利润"
      />
      <V2OverviewMetric
        label="全部资金流入"
        :value="formatCny(page.inflowSummary.totalInflowCny)"
        note="含股东投入与借入资金"
      />
    </template>
    <template #actions>
      <span>{{ historyStatusLabel(page.settings?.historyStatus) }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="page.canPost" variant="primary" @click="page.openExpense()">
        <el-icon><Plus /></el-icon>
        开支记账
      </AppButton>
      <AppButton v-if="page.canPost" variant="primary" @click="page.openInflow()">
        <el-icon><Plus /></el-icon>
        收入记账
      </AppButton>
      <AppButton
        v-if="page.canPost"
        variant="primary"
        @click="
          page.cashbookView = 'exchanges';
          page.exchangeDrawerVisible = true;
        "
        >换汇录入</AppButton
      >
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatCny, historyStatusLabel } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
