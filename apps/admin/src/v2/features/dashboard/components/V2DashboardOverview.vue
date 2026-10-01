<template>
  <V2PageOverview
    v-if="page.overview"
    class="v2-dashboard-overview"
    data-theme-dashboard-overview
    aria-label="仪表盘经营概览"
    title="经营状态总览"
    :help="
      ' 业务日 ' +
      page.overview.businessDate +
      ' · 中国标准时间' +
      ' ' +
      ' 权限外数据明确显示为“无权限”，不使用 0 代替。 '
    "
    metrics-label="当前经营关键指标"
  >
    <template #meta>业务日 {{ page.overview.businessDate }} · 中国标准时间</template>
    <template #metrics>
      <V2OverviewMetric
        label="需处理风险"
        :value="page.activeRiskCategoryCount"
        note="当前异常类别"
        :danger="page.activeRiskCategoryCount > 0"
      />
      <V2OverviewMetric
        label="今日完成"
        :value="valueWithSuffix(page.overview.business.todayCompletedOrders, '单')"
        note="仍为完成状态"
      />
      <V2OverviewMetric
        label="可用 ID"
        :value="valueWithSuffix(page.overview.assets.availableAccounts, '个')"
        note="未售且未报损"
      />
      <V2OverviewMetric
        label="今日利润"
        :value="page.formatDashboardMoney(page.overview.business.todayProfitCny)"
        note="已确认订单利润"
      />
    </template>
    <template #actions>
      <span>更新于 {{ page.formatDashboardDate(page.overview.generatedAt) }}</span>
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
import type { useDashboardPage } from '../useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{ page: DashboardPage }>();

function valueWithSuffix(value: number | null, suffix: string) {
  return value === null ? '无权限' : `${value} ${suffix}`;
}
</script>
