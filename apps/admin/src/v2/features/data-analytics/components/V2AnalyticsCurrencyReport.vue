<template>
  <section class="v2-analytics-section-stack" aria-label="原币资金收支">
    <div class="v2-finance-currency-strip" aria-label="分币种净现金流摘要">
      <article v-for="row in overview.currencyBreakdown" :key="row.currency">
        <header>
          <el-tag effect="plain">{{ row.currency }}</el-tag>
          <small>最新汇率 {{ row.latestRateToCny ?? '缺失' }}</small>
        </header>
        <strong :class="amountTone(row.netCashFlow)">
          {{ formatOriginal(row.netCashFlow, row.currency) }}
        </strong>
        <span>
          流入 {{ formatOriginal(row.income, row.currency) }} · 支出
          {{ formatOriginal(row.expense, row.currency) }}
        </span>
        <small>
          经营 {{ formatOriginal(row.manualOperatingIncome, row.currency) }} · 股东
          {{ formatOriginal(row.capitalContribution, row.currency) }} · 借入
          {{ formatOriginal(row.borrowedFunds, row.currency) }}
        </small>
      </article>
    </div>

    <section ref="listRef" class="v2-analytics-report-list v2-records-list" :style="listFrameStyle">
      <header class="v2-analytics-report-list__header">
        <V2SectionHeading
          title="原币资金收支"
          help="按币种展示现金流入、支出和净现金流，并拆分手工经营收入、股东投入与借入资金。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.dataAnalytics.currencies" />
            <span>本页 {{ overview.currencyBreakdown.length }} 条</span>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.dataAnalytics.currencies"
        :show-column-settings="false"
        class="v2-records-table"
        :data="overview.currencyBreakdown"
        scrollbar-always-on
        show-overflow-tooltip
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>当前范围暂无原币收支</strong>
            <span>完成订单或记账后会按币种汇总到这里</span>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[0]">
          <template #default="{ row }">
            <el-tag effect="plain">{{ row.currency }}</el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[1]">
          <template #default="{ row }">{{ formatOriginal(row.income, row.currency) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[2]">
          <template #default="{ row }">{{
            formatOriginal(row.manualOperatingIncome, row.currency)
          }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[3]">
          <template #default="{ row }">{{
            formatOriginal(row.capitalContribution, row.currency)
          }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[4]">
          <template #default="{ row }">{{
            formatOriginal(row.borrowedFunds, row.currency)
          }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[5]">
          <template #default="{ row }">{{ formatOriginal(row.expense, row.currency) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[6]">
          <template #default="{ row }">
            <strong :class="amountTone(row.netCashFlow)">
              {{ formatOriginal(row.netCashFlow, row.currency) }}
            </strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[7]">
          <template #default="{ row }">{{ row.latestRateToCny ?? '缺失' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[8]">
          <template #default="{ row }">
            {{ row.netCashFlowCny === null ? '—' : formatCny(row.netCashFlowCny) }}
          </template>
        </V2TableColumn>
      </V2Table>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { V2FinanceCurrency, V2FinanceOverview } from '@apple-business/shared';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';

const props = defineProps<{
  overview: V2FinanceOverview;
  formatCny: (value: string | null | undefined) => string;
  formatOriginal: (value: string, currency: V2FinanceCurrency) => string;
  amountTone: (value: string | null | undefined) => string;
}>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.overview.currencyBreakdown,
  pageSize: () => 4
});
</script>
