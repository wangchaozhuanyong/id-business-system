<template>
  <el-tabs v-model="page.activeTab" class="v2-exchange-tabs">
    <el-tab-pane label="自动采集记录" name="automatic">
      <section class="v2-exchange-toolbar" aria-label="自动采集记录筛选">
        <el-input
          v-model="page.runQuery.keyword"
          clearable
          placeholder="批次编号、错误代码"
          aria-label="搜索采集记录"
          @keyup.enter="page.searchRuns"
          @clear="page.searchRuns"
        />
        <el-select
          v-model="page.runQuery.status"
          clearable
          placeholder="全部状态"
          aria-label="筛选采集状态"
          @change="page.searchRuns"
        >
          <el-option label="采集中" value="running" />
          <el-option label="成功" value="success" />
          <el-option label="失败" value="failed" />
        </el-select>
        <el-select
          v-model="page.runQuery.triggerType"
          clearable
          placeholder="全部触发方式"
          aria-label="筛选触发方式"
          @change="page.searchRuns"
        >
          <el-option label="定时采集" value="scheduled" />
          <el-option label="立即采集" value="manual" />
          <el-option label="系统采集" value="system" />
        </el-select>
        <el-date-picker
          v-model="page.runDateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="筛选采集日期"
          @change="page.searchRuns"
        />
        <AppButton icon-only title="搜索" @click="page.searchRuns">
          <el-icon><Search /></el-icon>
        </AppButton>
      </section>

      <V2AsyncRegion
        skeleton="table"
        :loading="page.runLoading"
        :resolved="page.runResolved"
        :error="page.runError"
        loading-title="正在加载采集记录"
        refreshing-title="正在更新采集记录"
        error-title="采集记录加载失败"
        @retry="page.loadRuns"
      >
        <section class="v2-exchange-list">
          <V2Table
            :schema="v2TableSchemas.exchangeRates.snapshots"
            :aria-busy="page.runLoading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-exchange-table"
            :data="page.runs"
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无联网采集记录</strong>
                <span>到期调度或立即采集后会生成真实批次</span>
              </div>
            </template>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[0]">
              <template #default="{ row }">{{ page.formatDate(row.startedAt) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[1]">
              <template #default="{ row }">
                <el-tag :type="page.runStatusType(row.status)" size="small" effect="plain">
                  {{ page.runStatusLabel(row.status) }}
                </el-tag>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[2]">
              <template #default="{ row }">{{ page.triggerLabel(row.triggerType) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[3]">
              <template #default="{ row }">¥{{ page.formatAmount(row.targetAmountRmb) }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[4]">
              <template #default="{ row }">
                {{ page.formatRate(row.snapshot?.combinedMerchantBuyAverageRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[5]">
              <template #default="{ row }">
                {{ page.formatRate(row.snapshot?.combinedMerchantSellAverageRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[6]">
              <template #default="{ row }">
                <strong class="v2-exchange-table-rate">
                  {{ page.formatRate(row.snapshot?.midRateToRmb) }}
                </strong>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[7]">
              <template #default="{ row }">{{ row.snapshot?.validSampleCount ?? '—' }}</template>
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.exchangeRates.snapshots.columns[8]"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{ row.error ? page.failureLabel(row) : '—' }}
              </template>
            </V2TableColumn>
            <V2TableActionColumn :definition="v2TableSchemas.exchangeRates.snapshots.columns[9]">
              <template #default="{ row }">
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看批次"
                  @click="page.openRun(row)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <div class="v2-exchange-mobile-list">
            <article v-for="run in page.runs" :key="run.id" class="v2-exchange-mobile-item">
              <header>
                <div>
                  <el-tag :type="page.runStatusType(run.status)" size="small" effect="plain">
                    {{ page.runStatusLabel(run.status) }}
                  </el-tag>
                  <strong>{{ page.formatRate(run.snapshot?.midRateToRmb) }}</strong>
                </div>
                <time>{{ page.formatDate(run.startedAt) }}</time>
              </header>
              <dl>
                <div>
                  <dt>触发 / 档位</dt>
                  <dd>
                    {{ page.triggerLabel(run.triggerType) }} / ¥{{
                      page.formatAmount(run.targetAmountRmb)
                    }}
                  </dd>
                </div>
                <div>
                  <dt>综合买入 / 卖出</dt>
                  <dd>
                    {{ page.formatRate(run.snapshot?.combinedMerchantBuyAverageRateToRmb) }} /
                    {{ page.formatRate(run.snapshot?.combinedMerchantSellAverageRateToRmb) }}
                  </dd>
                </div>
                <div v-if="run.error">
                  <dt>失败原因</dt>
                  <dd>{{ page.failureLabel(run) }}</dd>
                </div>
              </dl>
              <footer>
                <span>{{ run.snapshot?.validSampleCount ?? 0 }} 条有效样本</span>
                <AppButton
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看批次"
                  @click="page.openRun(run)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </footer>
            </article>
          </div>

          <footer class="v2-records-pagination">
            <span>共 {{ page.runTotal }} 条</span>
            <el-pagination
              v-model:current-page="page.runQuery.page"
              v-model:page-size="page.runQuery.pageSize"
              v-pagination-label
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="page.runTotal"
              @current-change="page.loadRuns"
              @size-change="page.resetRunPage"
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
          placeholder="备注、操作人"
          @keyup.enter="page.searchManual"
          @clear="page.searchManual"
        />
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
                {{ page.formatRate(row.binanceMerchantBuyRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[2]">
              <template #default="{ row }">
                {{ page.formatRate(row.binanceMerchantSellRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[3]">
              <template #default="{ row }">
                {{ page.formatRate(row.okxMerchantBuyRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[4]">
              <template #default="{ row }">
                {{ page.formatRate(row.okxMerchantSellRateToRmb) }}
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[5]">
              <template #default="{ row }">
                <strong class="v2-exchange-table-rate">{{
                  page.formatRate(row.midRateToRmb)
                }}</strong>
              </template>
            </V2TableColumn>
            <V2TableColumn :definition="v2TableSchemas.exchangeRates.manualChanges.columns[6]">
              <template #default="{ row }">{{ page.operatorName(row) }}</template>
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[7]"
              prop="remark"
              show-overflow-tooltip
            />
            <V2TableActionColumn
              :definition="v2TableSchemas.exchangeRates.manualChanges.columns[8]"
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
                  <strong>{{ page.formatRate(entry.midRateToRmb) }}</strong>
                </div>
                <time>{{ page.formatDate(entry.recordedAt) }}</time>
              </header>
              <dl>
                <div>
                  <dt>Binance 买入 / 卖出</dt>
                  <dd>
                    {{ page.formatRate(entry.binanceMerchantBuyRateToRmb) }} /
                    {{ page.formatRate(entry.binanceMerchantSellRateToRmb) }}
                  </dd>
                </div>
                <div>
                  <dt>OKX 买入 / 卖出</dt>
                  <dd>
                    {{ page.formatRate(entry.okxMerchantBuyRateToRmb) }} /
                    {{ page.formatRate(entry.okxMerchantSellRateToRmb) }}
                  </dd>
                </div>
                <div v-if="entry.remark">
                  <dt>备注</dt>
                  <dd>{{ entry.remark }}</dd>
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
