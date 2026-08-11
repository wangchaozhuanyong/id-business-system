<template>
  <section v-if="page.overview" class="v2-analytics-overview" aria-label="经营分析概览">
    <div class="v2-analytics-overview__intro">
      <span class="v2-analytics-overview__eyebrow">BUSINESS CONTROL</span>
      <h2>经营分析总览</h2>
      <p>统一查看已实现利润、原币收支、资产估值与账务闭环，不混入处理中业务。</p>
    </div>

    <div class="v2-analytics-overview__metrics" aria-label="当前经营分析指标">
      <article>
        <span>已结算订单</span>
        <strong>{{ page.overview.settlementPlatformReport.totals.completedOrderCount }}</strong>
        <small>当前筛选范围</small>
      </article>
      <article>
        <span>资金账户</span>
        <strong>{{ page.accounts.length }}</strong>
        <small>参与资产核算</small>
      </article>
      <article>
        <span>卡商钱包</span>
        <strong>{{ page.wallets.length }}</strong>
        <small>供应商多币种余额</small>
      </article>
      <article>
        <span>对账问题</span>
        <strong>{{ page.overview.reconciliation.issueCount }}</strong>
        <small>当前待核对项</small>
      </article>
    </div>

    <div class="v2-analytics-overview__actions">
      <span>{{ page.analysisRangeLabel }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useDataAnalyticsPage } from '../useDataAnalyticsPage';

type DataAnalyticsPage = UnwrapNestedRefs<ReturnType<typeof useDataAnalyticsPage>>;

defineProps<{ page: DataAnalyticsPage }>();
</script>
