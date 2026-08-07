<template>
  <el-tabs v-model="page.activeTab" class="v2-exchange-tabs">
    <el-tab-pane label="自动采集记录" name="automatic">
      <section class="v2-exchange-toolbar" aria-label="自动采集记录筛选">
        <el-input
          :model-value="page.records.length ? `${page.recordTotal} 条自动快照` : ''"
          readonly
          placeholder="自动快照记录"
          aria-label="自动快照记录数量"
        />
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
        <AppButton icon-only title="搜索" @click="page.searchRecords">
          <el-icon><Search /></el-icon>
        </AppButton>
      </section>

      <V2AsyncRegion
        skeleton="table"
        :loading="page.recordLoading"
        :resolved="page.recordResolved"
        :error="page.recordError"
        loading-title="正在加载采集记录"
        refreshing-title="正在更新采集记录"
        error-title="采集记录加载失败"
        @retry="page.loadRecords"
      >
        <section class="v2-exchange-list">
          <V2Table
            :schema="v2TableSchemas.exchangeRates.snapshots"
            :aria-busy="page.recordLoading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-exchange-table"
            :data="page.records"
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无联网采集记录</strong>
                <span>到期调度或立即采集后会生成真实批次</span>
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
                <strong class="v2-exchange-table-rate">
                  {{ page.formatRate(row.rateToCny) }}
                </strong>
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
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[5]">
              <template #default="{ row }">{{ row.businessDate }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[6]">
              <template #default="{ row }">{{ page.formatDate(row.expiresAt) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[7]">
              <template #default="{ row }">
                {{
                  row.exchangeRateRunId
                    ? `P2P 批次 ${row.exchangeRateRunId.slice(0, 8)}`
                    : row.sourceReference || '—'
                }}
              </template>
            </V2TableColumn>
            <V2TableActionColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[8]">
              <template #default="{ row }">
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看证据"
                  :disabled="!row.exchangeRateRunId"
                  @click="page.openRecordEvidence(row)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <div class="v2-exchange-mobile-list">
            <article
              v-for="record in page.records"
              :key="record.id"
              class="v2-exchange-mobile-item"
            >
              <header>
                <div>
                  <el-tag :type="page.recordStatusType(record.status)" size="small" effect="plain">
                    {{ page.recordStatusLabel(record.status) }}
                  </el-tag>
                  <strong>{{ record.currency }} {{ page.formatRate(record.rateToCny) }}</strong>
                </div>
                <time>{{ page.formatDate(record.capturedAt) }}</time>
              </header>
              <dl>
                <div>
                  <dt>来源</dt>
                  <dd>{{ page.receiptFxSourceLabel(record.source) }}</dd>
                </div>
                <div>
                  <dt>业务日期 / 过期时间</dt>
                  <dd>{{ record.businessDate }} / {{ page.formatDate(record.expiresAt) }}</dd>
                </div>
              </dl>
              <footer>
                <span>{{
                  record.exchangeRateRunId
                    ? '可查看 P2P 批次'
                    : record.sourceReference || 'ECB 证据'
                }}</span>
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看证据"
                  :disabled="!record.exchangeRateRunId"
                  @click="page.openRecordEvidence(record)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </footer>
            </article>
          </div>

          <footer class="v2-records-pagination">
            <span>共 {{ page.recordTotal }} 条</span>
            <el-pagination
              v-model:current-page="page.recordQuery.page"
              v-model:page-size="page.recordQuery.pageSize"
              v-pagination-label
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="page.recordTotal"
              @current-change="page.loadRecords"
              @size-change="page.resetRecordPage"
            />
          </footer>
        </section>
      </V2AsyncRegion>
    </el-tab-pane>

    <el-tab-pane label="人工记录" name="manual">
      <section class="v2-exchange-toolbar v2-exchange-toolbar--manual" aria-label="人工汇率筛选">
        <el-input
          v-model="page.manualQuery.keyword"
          clearable
          placeholder="原因、来源、操作人"
          @keyup.enter="page.searchManual"
          @clear="page.searchManual"
        />
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
          @change="page.searchManual"
        />
        <AppButton icon-only title="搜索" @click="page.searchManual">
          <el-icon><Search /></el-icon>
        </AppButton>
      </section>

      <V2AsyncRegion
        skeleton="table"
        :loading="page.manualLoading"
        :resolved="page.manualResolved"
        :error="page.manualError"
        loading-title="正在加载人工记录"
        refreshing-title="正在更新人工记录"
        error-title="人工记录加载失败"
        @retry="page.loadManualEntries"
      >
        <section class="v2-exchange-list">
          <V2Table
            :schema="v2TableSchemas.exchangeRates.manualChanges"
            :aria-busy="page.manualLoading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-exchange-table"
            :data="page.manualEntries"
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无人工汇率记录</strong>
                <span>人工记录不会覆盖联网汇率</span>
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
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[3]">
              <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[4]"
              show-overflow-tooltip
            >
              <template #default="{ row }">{{ row.reason || '—' }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[5]">
              <template #default="{ row }">{{ page.operatorName(row) }}</template>
            </V2TableColumn>
            <V2TableActionColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[6]"
            >
              <template #default="{ row }">
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看人工记录"
                  @click="page.openManualDetail(row)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <div class="v2-exchange-mobile-list">
            <article
              v-for="entry in page.manualEntries"
              :key="entry.id"
              class="v2-exchange-mobile-item"
            >
              <header>
                <div>
                  <el-tag type="info" size="small" effect="plain">人工记录</el-tag>
                  <strong>{{ entry.currency }} {{ page.formatRate(entry.rateToCny) }}</strong>
                </div>
                <time>{{ page.formatDate(entry.recordedAt) }}</time>
              </header>
              <dl>
                <div>
                  <dt>来源说明</dt>
                  <dd>{{ entry.sourceReference || '—' }}</dd>
                </div>
                <div v-if="entry.reason">
                  <dt>原因</dt>
                  <dd>{{ entry.reason }}</dd>
                </div>
              </dl>
              <footer>
                <span>{{ page.operatorName(entry) }}</span>
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看人工记录"
                  @click="page.openManualDetail(entry)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </footer>
            </article>
            <div v-if="!page.manualEntries.length" class="v2-records-empty">
              <strong>暂无人工汇率记录</strong>
              <span>人工记录不会覆盖联网汇率</span>
            </div>
          </div>

          <footer class="v2-records-pagination">
            <span>共 {{ page.manualTotal }} 条</span>
            <el-pagination
              v-model:current-page="page.manualQuery.page"
              v-model:page-size="page.manualQuery.pageSize"
              v-pagination-label
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="page.manualTotal"
              @current-change="page.loadManualEntries"
              @size-change="page.resetManualPage"
            />
          </footer>
        </section>
      </V2AsyncRegion>
    </el-tab-pane>
  </el-tabs>
</template>

<script setup lang="ts">
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { Search, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

defineProps<{
  page: ExchangeRatesPage;
}>();
</script>
