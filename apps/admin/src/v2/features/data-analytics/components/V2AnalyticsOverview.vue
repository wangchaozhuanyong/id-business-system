<template>
  <V2PageOverview
    v-if="page.overview"
    class="v2-analytics-overview"
    aria-label="经营分析概览"
    title="经营分析总览"
    help="统一查看已实现利润、原币收支、资产估值与账务闭环，不混入处理中业务。"
    metrics-label="当前经营分析指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="当前完成订单"
        :value="page.overview.settlementPlatformReport.totals.completedOrderCount"
        note="当前筛选范围"
      />
      <V2OverviewMetric label="资金账户" :value="page.accounts.length" note="参与资产核算" />
      <V2OverviewMetric label="卡商钱包" :value="page.wallets.length" note="供应商多币种余额" />
      <V2OverviewMetric
        label="对账问题"
        :value="page.overview.reconciliation.issueCount"
        note="当前待核对项"
      />
    </template>
    <template #actions>
      <span>{{ page.analysisRangeLabel }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useDataAnalyticsPage } from '../useDataAnalyticsPage';

type DataAnalyticsPage = UnwrapNestedRefs<ReturnType<typeof useDataAnalyticsPage>>;

defineProps<{ page: DataAnalyticsPage }>();
</script>
