<template>
  <section class="v2-finance-page">
    <section class="v2-finance-toolbar" aria-label="经营分析筛选">
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
      <div class="v2-records-toolbar__actions">
        <AppButton title="应用筛选" @click="applyFilters">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新经营分析" :disabled="loading" @click="refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
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

        <section class="v2-finance-metrics" aria-label="经营利润指标">
          <article class="v2-finance-metric v2-finance-metric--primary">
            <span>人民币净利润</span>
            <strong :class="amountTone(overview.profitLoss.netProfitCny)">
              {{ formatCny(overview.profitLoss.netProfitCny) }}
            </strong>
            <small>只含已实现经营结果</small>
          </article>
          <article class="v2-finance-metric">
            <span>销售收入</span>
            <strong>{{ formatCny(overview.profitLoss.salesRevenueCny) }}</strong>
            <small>仅已完成订单</small>
          </article>
          <article class="v2-finance-metric">
            <span>销售成本</span>
            <strong>{{
              formatCny(
                addAmounts(overview.profitLoss.giftCardCostCny, overview.profitLoss.idCostCny)
              )
            }}</strong>
            <small>余额成本＋已卖 ID 成本</small>
          </article>
          <article class="v2-finance-metric">
            <span>额外经营开支</span>
            <strong>{{ formatCny(overview.profitLoss.operatingExpenseCny) }}</strong>
            <small>手机、办公、工资等</small>
          </article>
          <article class="v2-finance-metric">
            <span>赎回及报损</span>
            <strong>{{
              formatCny(
                addAmounts(
                  overview.profitLoss.redemptionLossCny,
                  overview.profitLoss.balanceLossCny,
                  overview.profitLoss.idPurchaseLossCny
                )
              )
            }}</strong>
            <small>均进入已实现亏损</small>
          </article>
          <article class="v2-finance-metric">
            <span>待确认利润</span>
            <strong>{{ formatCny(overview.profitLoss.estimatedProfitCny) }}</strong>
            <small>处理中订单，不计入净利润</small>
          </article>
        </section>

        <V2SettlementPlatformReport :report="overview.settlementPlatformReport" />

        <section class="v2-finance-grid">
          <article class="v2-finance-panel">
            <header>
              <div>
                <span>原币资金收支</span>
                <strong>CNY / MYR / USDT 分币种核算</strong>
              </div>
            </header>
            <el-table
              class="v2-records-table"
              :data="overview.currencyBreakdown"
              row-key="currency"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <V2TableColumn kind="status" label="币种" width-preset="compact">
                <template #default="{ row }">
                  <el-tag effect="plain">{{ row.currency }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="收入" width-preset="standard">
                <template #default="{ row }">{{
                  formatOriginal(row.income, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="支出" width-preset="standard">
                <template #default="{ row }">{{
                  formatOriginal(row.expense, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="净现金流" width-preset="standard">
                <template #default="{ row }">
                  <strong :class="amountTone(row.netCashFlow)">
                    {{ formatOriginal(row.netCashFlow, row.currency) }}
                  </strong>
                </template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="最新汇率" width-preset="standard">
                <template #default="{ row }">{{ row.latestRateToCny ?? '缺失' }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="最新估值" width-preset="standard">
                <template #default="{ row }">
                  {{ row.netCashFlowCny === null ? '—' : formatCny(row.netCashFlowCny) }}
                </template>
              </V2TableColumn>
            </el-table>
          </article>

          <article class="v2-finance-panel">
            <header>
              <div>
                <span>资产余额</span>
                <strong>账面价值与最新汇率估值分开</strong>
              </div>
            </header>
            <dl class="v2-finance-asset-list">
              <div v-for="item in assetRows" :key="item.label">
                <dt>{{ item.label }}</dt>
                <dd>{{ formatCny(item.value) }}</dd>
              </div>
              <div class="is-total">
                <dt>资产账面合计</dt>
                <dd>{{ formatCny(overview.assets.totalBookValueCny) }}</dd>
              </div>
              <div>
                <dt>最新人民币估值</dt>
                <dd>
                  {{
                    overview.assets.totalLatestValuationCny === null
                      ? '汇率不完整'
                      : formatCny(overview.assets.totalLatestValuationCny)
                  }}
                </dd>
              </div>
              <div>
                <dt>未实现汇兑变化</dt>
                <dd :class="amountTone(overview.assets.unrealizedFxChangeCny)">
                  {{
                    overview.assets.unrealizedFxChangeCny === null
                      ? '—'
                      : formatCny(overview.assets.unrealizedFxChangeCny)
                  }}
                </dd>
              </div>
            </dl>
          </article>
        </section>

        <section class="v2-finance-panel">
          <header>
            <div>
              <span>卡商资金</span>
              <strong>充值不计亏损，购卡、退款与调整形成余额变化</strong>
            </div>
          </header>
          <el-table
            class="v2-records-table"
            :data="wallets"
            row-key="id"
            scrollbar-always-on
            show-overflow-tooltip
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>暂无卡商钱包</strong>
                <span>请到财务记账创建供应商多币种钱包</span>
              </div>
            </template>
            <V2TableColumn kind="text" label="供应商" width-preset="identifier" fixed="left">
              <template #default="{ row }"
                ><strong>{{ row.supplierName }}</strong></template
              >
            </V2TableColumn>
            <V2TableColumn kind="status" label="币种" width-preset="compact">
              <template #default="{ row }"
                ><el-tag effect="plain">{{ row.currency }}</el-tag></template
              >
            </V2TableColumn>
            <V2TableColumn kind="numeric" label="期初余额" width-preset="standard">
              <template #default="{ row }">{{
                formatOriginal(row.openingBalance, row.currency)
              }}</template>
            </V2TableColumn>
            <V2TableColumn kind="numeric" label="当前余额" width-preset="standard">
              <template #default="{ row }">
                <strong>{{ formatOriginal(row.currentBalance, row.currency) }}</strong>
              </template>
            </V2TableColumn>
            <V2TableColumn kind="numeric" label="账面人民币" width-preset="standard">
              <template #default="{ row }">{{ formatCny(row.currentBalanceCny) }}</template>
            </V2TableColumn>
            <V2TableColumn kind="status" label="状态" width-preset="compact">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
                  {{ row.status === 'active' ? '启用' : '停用' }}
                </el-tag>
              </template>
            </V2TableColumn>
          </el-table>
        </section>

        <section class="v2-finance-panel">
          <header>
            <div>
              <span>盈亏与账务明细</span>
              <strong>可追溯订单、卡片、ID、损失和开支来源</strong>
            </div>
          </header>
          <el-table
            class="v2-records-table"
            :data="journals"
            row-key="id"
            scrollbar-always-on
            show-overflow-tooltip
          >
            <template #empty>
              <div class="v2-records-empty">
                <strong>当前筛选范围没有财务流水</strong>
                <span>完成订单或记账后会自动出现在这里</span>
              </div>
            </template>
            <V2TableColumn kind="text" type="expand" width="52" label="明细">
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
            </V2TableColumn>
            <V2TableColumn kind="identifier" label="财务流水号" width-preset="wide" fixed="left">
              <template #default="{ row }"
                ><strong>{{ row.journalNo }}</strong></template
              >
            </V2TableColumn>
            <V2TableColumn kind="date" label="发生时间" width-preset="dateTime">
              <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
            </V2TableColumn>
            <V2TableColumn kind="status" label="业务类型" min-width="150">
              <template #default="{ row }">
                <el-tag effect="plain">{{ journalTypeLabel(row.journalType) }}</el-tag>
              </template>
            </V2TableColumn>
            <V2TableColumn kind="text" label="摘要" min-width="220" prop="summary" />
            <V2TableColumn kind="identifier" label="来源单号" min-width="170">
              <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
            </V2TableColumn>
            <V2TableColumn kind="numeric" label="人民币金额" width-preset="standard">
              <template #default="{ row }">{{ formatCny(journalAmount(row)) }}</template>
            </V2TableColumn>
          </el-table>
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
      </template>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
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
</script>
