<template>
  <section class="v2-finance-page">
    <V2AsyncRegion
      variant="section"
      skeleton="metrics"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.error"
      loading-title="正在核算经营数据"
      refreshing-title="正在更新经营数据"
      error-title="经营分析加载失败"
      @retry="page.refresh"
    >
      <template v-if="page.overview">
        <div class="v2-analytics-page">
          <V2AnalyticsOverview :page="page" />

          <el-alert
            v-if="page.overview.settings.historyStatus !== 'completed'"
            type="warning"
            title="历史数据尚未完整确认"
            :description="
              page.overview.settings.historyNote ||
              '请在财务记账中完成历史回填、期初余额和遗漏开支确认。'
            "
            show-icon
            :closable="false"
          />

          <V2AnalyticsToolbar :page="page" />
          <V2AnalyticsNavigation v-model:active-section="activeAnalysisSection" />

          <div class="v2-analytics-content">
            <div v-show="activeAnalysisSection === 'profit'" class="v2-analytics-section-stack">
              <V2ProfitOverview
                :overview="page.overview"
                :analysis-range-label="page.analysisRangeLabel"
                :format-cny="page.formatCny"
                :add-amounts="page.addAmounts"
                :amount-tone="page.amountTone"
              />
              <V2SettlementPlatformReport :report="page.overview.settlementPlatformReport" />
            </div>

            <V2AfterSalesReport
              v-show="activeAnalysisSection === 'after-sales'"
              :report="page.overview.afterSales"
              :format-cny="page.formatCny"
              :amount-tone="page.amountTone"
            />

            <V2AnalyticsCurrencyReport
              v-show="activeAnalysisSection === 'cash-flow'"
              :overview="page.overview"
              :format-cny="page.formatCny"
              :format-original="page.formatOriginal"
              :amount-tone="page.amountTone"
            />

            <V2AnalyticsAssetsReport
              v-show="activeAnalysisSection === 'assets'"
              :overview="page.overview"
              :asset-rows="page.assetRows"
              :wallets="page.wallets"
              :format-cny="page.formatCny"
              :format-original="page.formatOriginal"
              :amount-tone="page.amountTone"
            />

            <V2AnalyticsReconciliationReport
              v-show="activeAnalysisSection === 'reconciliation'"
              :overview="page.overview"
              :journals="page.journals"
              :format-cny="page.formatCny"
              :format-original="page.formatOriginal"
              :format-date="page.formatDate"
              :journal-amount="page.journalAmount"
              :journal-type-label="page.journalTypeLabel"
              :account-code-label="page.accountCodeLabel"
              :direction-label="page.directionLabel"
            />
          </div>
        </div>
      </template>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2AfterSalesReport from './components/V2AfterSalesReport.vue';
import V2AnalyticsAssetsReport from './components/V2AnalyticsAssetsReport.vue';
import V2AnalyticsCurrencyReport from './components/V2AnalyticsCurrencyReport.vue';
import V2AnalyticsNavigation, {
  type AnalyticsSectionKey
} from './components/V2AnalyticsNavigation.vue';
import V2AnalyticsOverview from './components/V2AnalyticsOverview.vue';
import V2AnalyticsReconciliationReport from './components/V2AnalyticsReconciliationReport.vue';
import V2AnalyticsToolbar from './components/V2AnalyticsToolbar.vue';
import V2ProfitOverview from './components/V2ProfitOverview.vue';
import V2SettlementPlatformReport from './components/V2SettlementPlatformReport.vue';
import { useDataAnalyticsPage } from './useDataAnalyticsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/finance.css';

const page = reactive(useDataAnalyticsPage());
const activeAnalysisSection = ref<AnalyticsSectionKey>('profit');
</script>
