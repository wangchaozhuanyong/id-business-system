<template>
  <section class="v2-finance-panel v2-settlement-report">
    <header>
      <div>
        <span>结算平台收款</span>
        <strong>按订单创建时间归属，已结算与处理中金额分开</strong>
      </div>
      <el-tag effect="plain">{{ report.totals.completedOrderCount }} 笔已结算</el-tag>
    </header>

    <el-alert
      v-if="report.hasHistoricalUnspecified"
      type="warning"
      title="存在历史未指定结算平台的订单"
      :description="`历史未指定平台实收 ${formatCny(
        report.historicalUnspecifiedAmountCny
      )}，新订单已强制选择结算平台。`"
      show-icon
      :closable="false"
    />

    <div class="v2-settlement-summary">
      <article>
        <span>人民币实收</span>
        <strong>{{ formatCny(report.totals.grossReceivedCny) }}</strong>
      </article>
      <article>
        <span>退款金额</span>
        <strong>{{ formatCny(report.totals.refundedCny) }}</strong>
      </article>
      <article>
        <span>净入账</span>
        <strong>{{ formatCny(report.totals.netSettlementCny) }}</strong>
      </article>
      <article>
        <span>已实现利润</span>
        <strong :class="amountTone(report.totals.realizedProfitCny)">
          {{ formatCny(report.totals.realizedProfitCny) }}
        </strong>
      </article>
    </div>

    <V2Table
      :schema="v2TableSchemas.dataAnalytics.settlementPlatforms"
      class="v2-records-table"
      :data="report.rows"
      :row-key="settlementPlatformRowKey"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <div class="v2-records-empty">
          <strong>当前范围暂无结算平台数据</strong>
          <span>完成订单后会按财务流水汇总到这里</span>
        </div>
      </template>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[0]">
        <template #default="{ row }">
          <strong>{{ row.settlementPlatform?.name || '未指定平台（历史）' }}</strong>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[1]">
        <template #default="{ row }">{{ row.completedOrderCount }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[2]">
        <template #default="{ row }">
          {{ formatOriginalAmounts(row.originalAmounts, 'grossReceived') }}
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[3]">
        <template #default="{ row }">
          {{ formatOriginalAmounts(row.originalAmounts, 'refunded') }}
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[4]">
        <template #default="{ row }">{{ formatCny(row.grossReceivedCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[5]">
        <template #default="{ row }">{{ formatCny(row.refundedCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[6]">
        <template #default="{ row }">{{ formatCny(row.platformFeeCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[7]">
        <template #default="{ row }">
          <strong>{{ formatCny(row.netSettlementCny) }}</strong>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[8]">
        <template #default="{ row }">
          <strong :class="amountTone(row.realizedProfitCny)">
            {{ formatCny(row.realizedProfitCny) }}
          </strong>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[9]">
        <template #default="{ row }">
          {{ row.realizedProfitRate === null ? '—' : `${row.realizedProfitRate}%` }}
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.dataAnalytics.settlementPlatforms.columns[10]">
        <template #default="{ row }">
          {{ row.pendingOrderCount }} 笔 / {{ formatCny(row.pendingReceivedCny) }} / 利润
          {{ formatCny(row.pendingProfitCny) }}
        </template>
      </V2TableColumn>
    </V2Table>
  </section>
</template>

<script setup lang="ts">
import type {
  V2FinanceCurrency,
  V2SettlementPlatformOriginalAmount,
  V2SettlementPlatformReport,
  V2SettlementPlatformReportRow
} from '@apple-business/shared';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { formatV2Decimal } from '@/v2/utils/decimal';

defineProps<{
  report: V2SettlementPlatformReport;
}>();

function settlementPlatformRowKey(row: V2SettlementPlatformReportRow) {
  return row.settlementPlatform?.id ?? 'historical-unspecified';
}

function formatOriginalAmounts(
  values: V2SettlementPlatformOriginalAmount[],
  field: 'grossReceived' | 'refunded'
) {
  const nonZero = values.filter((item) => !/^(?:0|0\.0+)$/.test(item[field]));
  return nonZero.length
    ? nonZero.map((item) => formatOriginal(item[field], item.currency)).join('；')
    : '—';
}

function formatCny(value: string) {
  return `¥${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}

function amountTone(value: string) {
  if (value.startsWith('-') && !/^-(?:0|0\.0+)$/.test(value)) return 'is-negative';
  return /^(?:0|0\.0+)$/.test(value) ? '' : 'is-positive';
}
</script>
