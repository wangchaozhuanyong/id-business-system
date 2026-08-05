<template>
  <section class="v2-finance-page">
    <section class="v2-finance-filter-summary" aria-label="经营分析范围">
      <div class="v2-finance-filter-summary__copy">
        <span class="v2-finance-eyebrow">经营决策台</span>
        <strong>{{ analysisRangeLabel }}</strong>
        <small>Asia/Kuala_Lumpur · {{ activeFilterLabel }}</small>
        <span class="v2-finance-filter-summary__currency">本位币 CNY</span>
      </div>
      <V2FilterDisclosure label="展开筛选">
        <el-date-picker
          v-model="filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="筛选业务日期"
        />
        <el-select v-model="filters.currency" clearable placeholder="全部币种">
          <el-option v-for="item in currencies" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="filters.supplierOptionId" clearable placeholder="全部供应商">
          <el-option
            v-for="item in supplierOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <el-select v-model="filters.journalType" clearable placeholder="全部业务类型">
          <el-option
            v-for="item in journalTypeOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <el-select v-model="filters.financeAccountId" clearable placeholder="全部资金账户">
          <el-option
            v-for="item in accounts"
            :key="item.id"
            :label="`${item.name} · ${item.currency}`"
            :value="item.id"
          />
        </el-select>
        <el-select
          v-model="filters.settlementPlatformOptionId"
          clearable
          filterable
          placeholder="全部结算平台"
        >
          <el-option
            v-for="item in settlementPlatformOptions"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </el-select>
        <div class="v2-finance-filter-actions">
          <AppButton title="应用筛选" @click="applyFilters">
            <el-icon><Search /></el-icon>
            查询
          </AppButton>
          <AppButton title="重置筛选" variant="ghost" @click="resetFilters">
            <el-icon><RefreshLeft /></el-icon>
            重置
          </AppButton>
          <AppButton icon-only title="刷新经营分析" :disabled="loading" @click="refresh">
            <el-icon><Refresh /></el-icon>
          </AppButton>
        </div>
      </V2FilterDisclosure>
    </section>

    <V2AsyncRegion
      variant="section"
      skeleton="metrics"
      :loading="loading"
      :resolved="resolved"
      :error="error"
      loading-title="正在核算经营数据"
      refreshing-title="正在更新经营数据"
      error-title="经营分析加载失败"
      @retry="refresh"
    >
      <template v-if="overview">
        <el-alert
          v-if="overview.settings.historyStatus !== 'completed'"
          type="warning"
          title="历史数据尚未完整确认"
          :description="
            overview.settings.historyNote || '请在财务记账中完成历史回填、期初余额和遗漏开支确认。'
          "
          show-icon
          :closable="false"
        />

        <nav class="v2-finance-analysis-nav" aria-label="经营分析分区">
          <button
            v-for="section in analysisSections"
            :key="section.key"
            type="button"
            :class="{ 'is-active': activeAnalysisSection === section.key }"
            :aria-current="activeAnalysisSection === section.key ? 'page' : undefined"
            @click="activeAnalysisSection = section.key"
          >
            <span>{{ section.label }}</span>
            <small>{{ section.description }}</small>
          </button>
        </nav>

        <div v-show="activeAnalysisSection === 'profit'" class="v2-finance-analysis-stack">
          <V2ProfitOverview
            :overview="overview"
            :analysis-range-label="analysisRangeLabel"
            :format-cny="formatCny"
            :add-amounts="addAmounts"
            :amount-tone="amountTone"
          />

          <V2SettlementPlatformReport :report="overview.settlementPlatformReport" />
        </div>

        <section
          v-show="activeAnalysisSection === 'cash-flow'"
          class="v2-finance-analysis-stack"
          aria-label="原币资金收支"
        >
          <div class="v2-finance-currency-strip" aria-label="分币种净现金流摘要">
            <article v-for="row in overview.currencyBreakdown" :key="row.currency">
              <header>
                <el-tag effect="plain">{{ row.currency }}</el-tag>
                <small>最新汇率 {{ row.latestRateToCny ?? '缺失' }}</small>
              </header>
              <strong :class="amountTone(row.netCashFlow)">
                {{ formatOriginal(row.netCashFlow, row.currency) }}
              </strong>
              <span
                >收入 {{ formatOriginal(row.income, row.currency) }} · 支出
                {{ formatOriginal(row.expense, row.currency) }}</span
              >
            </article>
          </div>

          <article class="v2-finance-panel">
            <header>
              <div>
                <span>原币资金收支</span>
                <strong>CNY / MYR / USDT 分币种核算</strong>
              </div>
            </header>
            <V2Table
              :schema="v2TableSchemas.dataAnalytics.currencies"
              class="v2-records-table"
              :data="overview.currencyBreakdown"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[0]">
                <template #default="{ row }">
                  <el-tag effect="plain">{{ row.currency }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[1]">
                <template #default="{ row }">{{
                  formatOriginal(row.income, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[2]">
                <template #default="{ row }">{{
                  formatOriginal(row.expense, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[3]">
                <template #default="{ row }">
                  <strong :class="amountTone(row.netCashFlow)">
                    {{ formatOriginal(row.netCashFlow, row.currency) }}
                  </strong>
                </template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[4]">
                <template #default="{ row }">{{ row.latestRateToCny ?? '缺失' }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.currencies.columns[5]">
                <template #default="{ row }">
                  {{ row.netCashFlowCny === null ? '—' : formatCny(row.netCashFlowCny) }}
                </template>
              </V2TableColumn>
            </V2Table>
          </article>
        </section>

        <div v-show="activeAnalysisSection === 'assets'" class="v2-finance-analysis-stack">
          <section class="v2-finance-asset-overview" aria-label="资产总览">
            <article class="is-primary">
              <span>资产账面合计</span>
              <strong>{{ formatCny(overview.assets.totalBookValueCny) }}</strong>
              <small>以历史交易汇率记录</small>
            </article>
            <article>
              <span>最新人民币估值</span>
              <strong>
                {{
                  overview.assets.totalLatestValuationCny === null
                    ? '汇率不完整'
                    : formatCny(overview.assets.totalLatestValuationCny)
                }}
              </strong>
              <small>只用于当前资产估值</small>
            </article>
            <article>
              <span>未实现汇兑变化</span>
              <strong :class="amountTone(overview.assets.unrealizedFxChangeCny)">
                {{
                  overview.assets.unrealizedFxChangeCny === null
                    ? '—'
                    : formatCny(overview.assets.unrealizedFxChangeCny)
                }}
              </strong>
              <small>不进入经营净利润</small>
            </article>
          </section>

          <article class="v2-finance-panel">
            <header>
              <div>
                <span>资产构成</span>
                <strong>自有资金、预付款、库存成本与待退款</strong>
              </div>
            </header>
            <dl class="v2-finance-asset-list">
              <div v-for="item in assetRows" :key="item.label">
                <dt>{{ item.label }}</dt>
                <dd>{{ formatCny(item.value) }}</dd>
              </div>
            </dl>
          </article>

          <section class="v2-finance-panel">
            <header>
              <div>
                <span>卡商资金</span>
                <strong>充值不计亏损，购卡、退款与调整形成余额变化</strong>
              </div>
            </header>
            <V2Table
              :schema="v2TableSchemas.dataAnalytics.supplierWallets"
              class="v2-records-table"
              :data="wallets"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <div class="v2-records-empty">
                  <strong>暂无卡商钱包</strong>
                  <span>请到财务记账创建供应商多币种钱包</span>
                </div>
              </template>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[0]">
                <template #default="{ row }"
                  ><strong>{{ row.supplierName }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[1]">
                <template #default="{ row }"
                  ><el-tag effect="plain">{{ row.currency }}</el-tag></template
                >
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[2]">
                <template #default="{ row }">{{
                  formatOriginal(row.openingBalance, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[3]">
                <template #default="{ row }">
                  <strong>{{ formatOriginal(row.currentBalance, row.currency) }}</strong>
                </template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[4]">
                <template #default="{ row }">{{ formatCny(row.currentBalanceCny) }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[5]">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
                    {{ row.status === 'active' ? '启用' : '停用' }}
                  </el-tag>
                </template>
              </V2TableColumn>
            </V2Table>
          </section>
        </div>

        <div
          v-show="activeAnalysisSection === 'reconciliation'"
          class="v2-finance-reconciliation-grid"
        >
          <section class="v2-finance-panel">
            <header>
              <div>
                <span>盈亏与账务明细</span>
                <strong>可追溯订单、卡片、ID、损失和开支来源</strong>
              </div>
            </header>
            <V2Table
              :schema="v2TableSchemas.dataAnalytics.journals"
              class="v2-records-table"
              :data="journals"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <div class="v2-records-empty">
                  <strong>当前筛选范围没有财务流水</strong>
                  <span>完成订单或记账后会自动出现在这里</span>
                </div>
              </template>
              <V2TableControlColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[0]">
                <template #default="{ row }">
                  <div class="v2-finance-lines">
                    <div v-for="line in row.lines" :key="line.id">
                      <span>{{ accountCodeLabel(line.accountCode) }}</span>
                      <strong>{{ directionLabel(line.direction) }}</strong>
                      <span>{{ formatOriginal(line.amountOriginal, line.currency) }}</span>
                      <span>{{ formatCny(line.amountCny) }}</span>
                      <span>{{ line.memo || '—' }}</span>
                    </div>
                  </div>
                </template>
              </V2TableControlColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[1]">
                <template #default="{ row }"
                  ><strong>{{ row.journalNo }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[2]">
                <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[3]">
                <template #default="{ row }">
                  <el-tag effect="plain">{{ journalTypeLabel(row.journalType) }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.dataAnalytics.journals.columns[4]"
                prop="summary"
              />
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[5]">
                <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[6]">
                <template #default="{ row }">{{ formatCny(journalAmount(row)) }}</template>
              </V2TableColumn>
            </V2Table>
          </section>

          <section class="v2-finance-panel">
            <header>
              <div>
                <span>闭环对账</span>
                <strong>
                  {{
                    overview.reconciliation.isComplete
                      ? '关键证据完整'
                      : `${overview.reconciliation.issueCount} 项待处理`
                  }}
                </strong>
              </div>
              <el-tag
                :type="overview.reconciliation.isComplete ? 'success' : 'warning'"
                effect="plain"
              >
                {{ overview.reconciliation.isComplete ? '已闭环' : '待核对' }}
              </el-tag>
            </header>
            <div v-if="overview.reconciliation.issues.length" class="v2-finance-issues">
              <article
                v-for="issue in overview.reconciliation.issues"
                :key="`${issue.code}:${issue.sourceId ?? issue.message}`"
                :class="`is-${issue.severity}`"
              >
                <el-tag
                  :type="
                    issue.severity === 'error'
                      ? 'danger'
                      : issue.severity === 'warning'
                        ? 'warning'
                        : 'info'
                  "
                  effect="plain"
                  size="small"
                >
                  {{
                    issue.severity === 'error'
                      ? '错误'
                      : issue.severity === 'warning'
                        ? '提醒'
                        : '信息'
                  }}
                </el-tag>
                <div>
                  <strong>{{ issue.message }}</strong>
                  <span v-if="issue.amountCny">{{ formatCny(issue.amountCny) }}</span>
                </div>
              </article>
            </div>
            <el-empty v-else description="当前筛选范围没有对账问题" />
          </section>
        </div>
      </template>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import V2ProfitOverview from './components/V2ProfitOverview.vue';
import V2SettlementPlatformReport from './components/V2SettlementPlatformReport.vue';
import { useDataAnalyticsPage } from './useDataAnalyticsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/finance.css';

const {
  currencies,
  journalTypeOptions,
  filters,
  overview,
  accounts,
  wallets,
  journals,
  loading,
  resolved,
  error,
  supplierOptions,
  settlementPlatformOptions,
  assetRows,
  analysisRangeLabel,
  activeFilterLabel,
  applyFilters,
  resetFilters,
  refresh,
  formatCny,
  formatOriginal,
  addAmounts,
  amountTone,
  formatDate,
  journalAmount,
  journalTypeLabel,
  accountCodeLabel,
  directionLabel
} = useDataAnalyticsPage();

const analysisSections = [
  { key: 'profit', label: '经营利润', description: '收入、成本与损益' },
  { key: 'cash-flow', label: '资金收支', description: 'CNY / MYR / USDT' },
  { key: 'assets', label: '资产余额', description: '账面值与最新估值' },
  { key: 'reconciliation', label: '账务对账', description: '日记与闭环问题' }
] as const;

const activeAnalysisSection = ref<(typeof analysisSections)[number]['key']>('profit');
</script>
