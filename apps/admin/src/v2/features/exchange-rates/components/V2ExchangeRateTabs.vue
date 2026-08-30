<template>
  <el-tabs v-model="page.activeTab" class="v2-exchange-tabs">
    <el-tab-pane label="收购报价" name="purchase" lazy>
      <V2PurchaseQuotePanel :page="page" />
    </el-tab-pane>

    <el-tab-pane label="采集记录" name="automatic" lazy>
      <section
        ref="recordListRef"
        class="v2-records-list v2-exchange-list"
        :style="recordListFrameStyle"
      >
        <header class="v2-exchange-list__header">
          <V2SectionHeading title="采集记录" help="查询自动采集快照及其来源证据。">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.exchangeRates.snapshots" />
              <strong>{{ page.recordResolved ? `${page.recordTotal} 条` : '—' }}</strong>
            </template>
          </V2SectionHeading>
        </header>

        <div
          class="v2-exchange-filterbar v2-exchange-filterbar--automatic"
          aria-label="采集记录筛选"
        >
          <el-select
            v-model="page.recordQuery.currency"
            clearable
            placeholder="全部币种"
            aria-label="筛选币种"
            @change="page.searchRecords"
          >
            <el-option
              v-for="currency in page.trackedCurrencies"
              :key="currency"
              :label="page.currencyLabel(currency)"
              :value="currency"
            />
          </el-select>
          <el-select
            v-model="page.recordQuery.source"
            clearable
            placeholder="全部来源"
            aria-label="筛选来源"
            @change="page.searchRecords"
          >
            <el-option label="Binance + OKX P2P" value="combined_p2p" />
            <el-option label="ECB 交叉汇率" value="ecb_cross" />
          </el-select>
          <el-select
            v-model="page.recordQuery.status"
            clearable
            placeholder="全部状态"
            aria-label="筛选汇率状态"
            @change="page.searchRecords"
          >
            <el-option label="有效" value="available" />
            <el-option label="已过期" value="expired" />
          </el-select>
          <el-date-picker
            v-model="page.recordDateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            aria-label="筛选采集日期"
            @change="page.searchRecords"
          />
        </div>

        <V2AsyncRegion
          skeleton="table"
          :phase="page.queryPhase"
          :previous-data="page.isParameterTransition"
          :error="page.recordError"
          loading-title="正在加载采集记录"
          refreshing-title="正在更新采集记录"
          error-title="采集记录加载失败"
          @retry="page.loadRecords"
        >
          <V2Table
            :schema="v2TableSchemas.exchangeRates.snapshots"
            :show-column-settings="false"
            :aria-busy="page.recordLoading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-exchange-table"
            :data="page.records"
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无采集记录</strong>
                <span>调整筛选条件，或先执行一次汇率采集</span>
              </div>
            </template>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[0]">
              <template #default="{ row }">{{ page.formatDate(row.capturedAt) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[1]">
              <template #default="{ row }">
                <el-tag type="info" size="small" effect="plain">{{ row.currency }}</el-tag>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[2]">
              <template #default="{ row }">
                <strong class="v2-exchange-table-rate">{{ page.formatRate(row.rateToCny) }}</strong>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[3]">
              <template #default="{ row }">{{ page.receiptFxSourceLabel(row.source) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[4]">
              <template #default="{ row }">
                <el-tag :type="page.recordStatusType(row.status)" size="small" effect="plain">
                  {{ page.recordStatusLabel(row.status) }}
                </el-tag>
              </template>
            </V2TableColumn>
            <V2TableActionColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[5]">
              <template #default="{ row }">
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="!row.exchangeRateRunId"
                  @click="page.openRecordEvidence(row)"
                >
                  查看证据
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <footer class="v2-records-pagination">
            <span>共 {{ page.recordTotal }} 条</span>
            <el-pagination
              v-pagination-label
              :current-page="page.recordDisplayedPage"
              :page-size="page.recordDisplayedPageSize"
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="page.recordTotal"
              :disabled="page.queryPhase === 'transitioning'"
              @current-change="page.handleRecordPageChange"
              @size-change="page.resetRecordPage"
            />
          </footer>
        </V2AsyncRegion>
      </section>
    </el-tab-pane>

    <el-tab-pane label="人工记录" name="manual" lazy>
      <section
        ref="manualListRef"
        class="v2-records-list v2-exchange-list"
        :style="manualListFrameStyle"
      >
        <header class="v2-exchange-list__header">
          <V2SectionHeading title="人工记录" help="核对人工汇率的原因、操作人与完整留痕。">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.exchangeRates.manualChanges" />
              <strong>{{ page.manualResolved ? `${page.manualTotal} 条` : '—' }}</strong>
              <AppButton v-if="page.canCreate" size="small" @click="page.openManualCreate">
                新增人工汇率
              </AppButton>
            </template>
          </V2SectionHeading>
        </header>

        <div class="v2-exchange-filterbar v2-exchange-filterbar--manual" aria-label="人工记录筛选">
          <el-input
            v-model="page.manualQuery.keyword"
            clearable
            placeholder="搜索原因、来源或操作人"
            aria-label="搜索人工汇率记录"
            @keyup.enter="page.searchManual"
            @clear="page.searchManual"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-select
            v-model="page.manualQuery.currency"
            clearable
            placeholder="全部币种"
            aria-label="筛选人工汇率币种"
            @change="page.searchManual"
          >
            <el-option
              v-for="currency in page.trackedCurrencies"
              :key="currency"
              :label="page.currencyLabel(currency)"
              :value="currency"
            />
          </el-select>
          <el-date-picker
            v-model="page.manualDateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="记录开始"
            end-placeholder="记录结束"
            aria-label="筛选人工汇率记录日期"
            @change="page.searchManual"
          />
          <AppButton variant="ghost" @click="page.searchManual">查询</AppButton>
        </div>

        <V2AsyncRegion
          skeleton="table"
          :phase="page.queryPhase"
          :previous-data="page.isParameterTransition"
          :error="page.manualError"
          loading-title="正在加载人工记录"
          refreshing-title="正在更新人工记录"
          error-title="人工记录加载失败"
          @retry="page.loadManualEntries"
        >
          <V2Table
            :schema="v2TableSchemas.exchangeRates.manualChanges"
            :show-column-settings="false"
            :aria-busy="page.manualLoading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-exchange-table"
            :data="page.manualEntries"
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无人工记录</strong>
                <span>调整筛选条件，或新增一条人工汇率</span>
              </div>
            </template>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[0]">
              <template #default="{ row }">{{ page.formatDate(row.recordedAt) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[1]">
              <template #default="{ row }">
                <el-tag type="info" size="small" effect="plain">{{ row.currency }}</el-tag>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[2]">
              <template #default="{ row }">
                <strong class="v2-exchange-table-rate">{{ page.formatRate(row.rateToCny) }}</strong>
              </template>
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[3]"
              show-overflow-tooltip
            >
              <template #default="{ row }">{{ row.reason || '—' }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[4]">
              <template #default="{ row }">{{ page.operatorName(row) }}</template>
            </V2TableColumn>
            <V2TableActionColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[5]"
            >
              <template #default="{ row }">
                <AppButton size="small" variant="ghost" @click="page.openManualDetail(row)">
                  查看详情
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <footer class="v2-records-pagination">
            <span>共 {{ page.manualTotal }} 条</span>
            <el-pagination
              v-pagination-label
              :current-page="page.manualDisplayedPage"
              :page-size="page.manualDisplayedPageSize"
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="page.manualTotal"
              :disabled="page.queryPhase === 'transitioning'"
              @current-change="page.handleManualPageChange"
              @size-change="page.resetManualPage"
            />
          </footer>
        </V2AsyncRegion>
      </section>
    </el-tab-pane>
  </el-tabs>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';
import V2PurchaseQuotePanel from './V2PurchaseQuotePanel.vue';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const props = defineProps<{
  page: ExchangeRatesPage;
}>();

const { listRef: recordListRef, listFrameStyle: recordListFrameStyle } = useV2StableListFrame({
  items: () => props.page.records,
  pageSize: () => props.page.recordQuery.pageSize
});
const { listRef: manualListRef, listFrameStyle: manualListFrameStyle } = useV2StableListFrame({
  items: () => props.page.manualEntries,
  pageSize: () => props.page.manualQuery.pageSize
});
</script>
