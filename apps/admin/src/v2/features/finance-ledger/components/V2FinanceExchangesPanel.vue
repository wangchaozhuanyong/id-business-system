<template>
  <div v-show="page.cashbookView === 'exchanges'" class="v2-finance-exchanges">
    <section class="v2-finance-expenses-command-panel" aria-label="换汇筛选">
      <div class="v2-finance-exchange-filters">
        <V2FinanceCurrencySelect
          v-model="state.filters.currency"
          clearable
          placeholder="全部币种"
          aria-label="换汇币种筛选"
          @change="state.search"
        />
        <el-select
          v-model="state.filters.financeAccountId"
          clearable
          filterable
          placeholder="全部账户"
          aria-label="换汇账户筛选"
          @change="state.search"
          ><el-option
            v-for="account in state.accounts"
            :key="account.id"
            :label="account.name"
            :value="account.id"
        /></el-select>
        <el-select
          v-model="state.filters.status"
          clearable
          placeholder="全部状态"
          aria-label="换汇状态筛选"
          @change="state.search"
          ><el-option label="已入账" value="posted" /><el-option label="已冲销" value="reversed"
        /></el-select>
        <el-input
          v-model="state.filters.dateFrom"
          type="date"
          aria-label="换汇开始日期"
          @change="state.search"
        />
        <el-input
          v-model="state.filters.dateTo"
          type="date"
          aria-label="换汇结束日期"
          @change="state.search"
        />
        <el-input
          v-model="state.filters.keyword"
          clearable
          placeholder="渠道、备注"
          aria-label="换汇搜索"
          @keyup.enter="state.search"
          @clear="state.search"
        />
        <el-select v-model="state.filters.sort" aria-label="换汇排序" @change="state.search"
          ><el-option label="时间从新到旧" value="newest" /><el-option
            label="时间从旧到新"
            value="oldest"
        /></el-select>
        <AppButton variant="soft" @click="state.search">查询</AppButton>
        <AppButton v-if="page.canPost" variant="primary" @click="state.open()">换汇录入</AppButton>
      </div>
    </section>
    <V2AsyncRegion
      skeleton="table"
      :phase="state.query.phase"
      :previous-data="state.query.isParameterTransition"
      :error="state.query.error ? getApiErrorMessage(state.query.error) : ''"
      loading-title="正在加载换汇记录"
      error-title="换汇记录加载失败"
      @retry="state.query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading
            title="换汇记录"
            help="换汇本金属于账户间资金转换。人民币费用与汇兑损益按入账快照汇总。"
            ><template #actions
              ><V2TableColumnSettings
                inline
                :schema="v2TableSchemas.financeLedger.exchanges"
              /><span>共 {{ state.query.data?.total ?? 0 }} 条</span></template
            ></V2SectionHeading
          >
        </header>
        <div
          v-if="state.query.data"
          class="v2-finance-exchange-summary"
          :style="{ minHeight: `${summaryHeight}px` }"
        >
          <div ref="summaryContentRef">
            <p>
              有效记录手续费 {{ formatCny(state.query.data.summary.feeAmountCny) }} · 汇兑损益
              {{ formatCny(state.query.data.summary.fxGainLossCny) }}
            </p>
            <div class="v2-finance-exchange-totals">
              <p v-for="item in state.query.data.summary.currencies" :key="item.currency">
                {{ financeCurrencyLabel(item.currency) }}：本金 {{ item.sourceAmount }} · 到账
                {{ item.targetAmount }} · 手续费 {{ item.feeAmount }}
              </p>
            </div>
          </div>
        </div>
        <V2Table
          :schema="v2TableSchemas.financeLedger.exchanges"
          :show-column-settings="false"
          :data="state.query.data?.items ?? []"
          class="v2-records-table"
          show-overflow-tooltip
        >
          <template #empty
            ><FinanceEmpty title="暂无换汇记录" description="录入付款账户与收款账户之间的实际换汇"
          /></template>
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[0]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[0])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[1]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[1])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[2]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[2])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[3]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[3])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[4]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[4])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[5]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[5])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[6]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[6])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[7]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[7])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[8]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[8])
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[9]"
            ><template #default="{ row }">{{
              cell(row, v2TableSchemas.financeLedger.exchanges.columns[9])
            }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.financeLedger.exchanges.columns[10]"
            ><template #default="{ row }"
              ><AppButton
                v-if="page.canAdjust && page.canPost"
                size="small"
                variant="ghost"
                :disabled="row.status !== 'posted'"
                @click="state.open(row)"
                >更正</AppButton
              ><AppButton
                v-if="page.canAdjust"
                size="small"
                variant="ghost"
                :disabled="row.status !== 'posted'"
                @click="state.openReverse(row)"
                >冲销</AppButton
              ></template
            ></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>第 {{ state.query.data?.page ?? 1 }} 页</span
          ><el-pagination
            :current-page="state.query.data?.page ?? 1"
            :page-size="20"
            :total="state.query.data?.total ?? 0"
            layout="prev, pager, next"
            :disabled="state.query.isParameterTransition"
            @current-change="state.changePage"
          />
        </footer>
      </section>
    </V2AsyncRegion>
  </div>
  <V2FinanceExchangeDrawer :page="page" :state="state" />
</template>
<script setup lang="ts">
import { reactive, ref, watch, type UnwrapNestedRefs } from 'vue';
import { financeCurrencyLabel, type V2FinanceExchange } from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatCny, formatDate, formatOriginal } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import { useFinanceExchanges } from '../useFinanceExchanges';
import V2FinanceExchangeDrawer from './V2FinanceExchangeDrawer.vue';
import FinanceEmpty from './FinanceEmpty';
const props = defineProps<{ page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>> }>();
const state = reactive(useFinanceExchanges(props.page));
const summaryContentRef = ref<HTMLElement>();
const summaryHeight = ref(0);
watch(
  summaryContentRef,
  (element, _previous, onCleanup) => {
    if (!element) return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const height = Math.ceil(entry.contentRect.height) + 16;
      summaryHeight.value =
        width === entry.contentRect.width ? Math.max(summaryHeight.value, height) : height;
      width = entry.contentRect.width;
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' }
);
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => state.query.data?.items ?? [],
  pageSize: () => 20
});
function cell(row: V2FinanceExchange, column: { key: string }) {
  const values: Record<string, string> = {
    occurredAt: formatDate(row.occurredAt),
    direction: `${financeCurrencyLabel(row.sourceCurrency)} → ${financeCurrencyLabel(row.targetCurrency)}`,
    accounts: `${row.sourceAccountName} → ${row.targetAccountName}`,
    sourceAmount: formatOriginal(row.sourceAmount, row.sourceCurrency),
    targetAmount: formatOriginal(row.targetAmount, row.targetCurrency),
    feeAmount: formatOriginal(
      row.feeAmount,
      row.feeMode === 'source_extra' ? row.sourceCurrency : row.targetCurrency
    ),
    feePercent: `${row.feePercent}%`,
    effectiveRate: `1 ${row.sourceCurrency} = ${row.effectiveRate} ${row.targetCurrency}`,
    channel: [row.channel, row.remark].filter(Boolean).join(' · ') || '—',
    status: row.status === 'reversed' ? '已冲销' : row.correctionOfId ? '已更正入账' : '已入账'
  };
  return values[column.key] ?? '—';
}
</script>
<style scoped>
.v2-finance-exchanges {
  padding-bottom: 72px;
}
.v2-finance-exchange-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 16px;
}
.v2-finance-exchange-summary {
  padding: 0 16px 16px;
}
.v2-finance-exchange-summary p {
  margin: 0;
  line-height: 1.6;
}
.v2-finance-exchange-totals {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}
@media (max-width: 700px) {
  .v2-finance-exchange-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
