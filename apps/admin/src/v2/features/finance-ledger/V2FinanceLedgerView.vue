<template>
  <section class="v2-finance-page">
    <section class="v2-finance-ledger-actions" aria-label="财务记账操作">
      <div>
        <AppButton
          v-if="page.activeTab === 'accounts' && page.canManage"
          @click="page.openAccount()"
        >
          <el-icon><Plus /></el-icon>
          新建资金账户
        </AppButton>
        <AppButton v-if="page.activeTab === 'wallets' && page.canManage" @click="page.openWallet">
          <el-icon><Plus /></el-icon>
          新建供应商钱包
        </AppButton>
        <AppButton v-if="page.activeTab === 'expenses' && page.canPost" @click="page.openExpense">
          <el-icon><Plus /></el-icon>
          记录经营开支
        </AppButton>
        <AppButton
          v-if="page.activeTab === 'periods' && page.canClose"
          @click="page.openPeriod('close')"
        >
          <el-icon><Lock /></el-icon>
          月度关账
        </AppButton>
      </div>
      <div>
        <el-select
          v-model="page.filters.currency"
          clearable
          placeholder="全部币种"
          aria-label="筛选币种"
          @change="page.applyFilters"
        >
          <el-option label="CNY" value="CNY" />
          <el-option label="MYR" value="MYR" />
          <el-option label="USDT" value="USDT" />
        </el-select>
        <el-input
          v-if="page.activeTab === 'journals'"
          v-model="page.filters.periodMonth"
          placeholder="月份 YYYY-MM"
          maxlength="7"
          aria-label="筛选财务月份"
          @keyup.enter="page.applyFilters"
        />
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新财务数据" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading"
      :resolved="page.resolved"
      :error="page.error"
      loading-title="正在加载财务账务"
      refreshing-title="正在更新财务账务"
      error-title="财务账务加载失败"
      @retry="page.refresh"
    >
      <el-alert
        v-if="page.settings?.historyStatus !== 'completed'"
        type="warning"
        title="生命周期利润仍不完整"
        :description="page.settings?.historyNote || '请先回填历史，再确认期初余额与旧开支。'"
        show-icon
        :closable="false"
      />

      <section class="v2-finance-panel v2-finance-ledger-tabs">
        <el-tabs v-model="page.activeTab">
          <el-tab-pane label="资金账户" name="accounts">
            <el-table
              class="v2-records-table"
              :data="page.accounts"
              row-key="id"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <FinanceEmpty title="暂无资金账户" description="先建立银行卡、现金或钱包账户" />
              </template>
              <V2TableColumn kind="text" label="账户" width-preset="identifier" fixed="left">
                <template #default="{ row }"
                  ><strong>{{ row.name }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn kind="status" label="类型" width-preset="compact">
                <template #default="{ row }">{{ accountTypeLabel(row.accountType) }}</template>
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
                  <strong :class="amountTone(row.currentBalance)">
                    {{ formatOriginal(row.currentBalance, row.currency) }}
                  </strong>
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
              <V2TableActionColumn v-if="page.canManage" layout="single">
                <template #default="{ row }">
                  <AppButton size="small" variant="ghost" @click="page.openAccount(row)">
                    编辑
                  </AppButton>
                </template>
              </V2TableActionColumn>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="供应商钱包" name="wallets">
            <el-table
              class="v2-records-table"
              :data="page.wallets"
              row-key="id"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <FinanceEmpty title="暂无供应商钱包" description="一个供应商可按币种分别建立钱包" />
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
              <V2TableColumn kind="date" label="初始化时间" width-preset="dateTime">
                <template #default="{ row }">{{ formatDate(row.initializedAt) }}</template>
              </V2TableColumn>
              <V2TableActionColumn v-if="page.canPost || page.canAdjust" layout="single">
                <template #default="{ row }">
                  <el-dropdown trigger="click" @command="handleWalletMutationCommand(row, $event)">
                    <AppButton size="small" variant="ghost">更多操作</AppButton>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="page.canPost" command="deposit">
                          供应商充值
                        </el-dropdown-item>
                        <el-dropdown-item v-if="page.canPost" command="refund">
                          收到供应商退款
                        </el-dropdown-item>
                        <el-dropdown-item v-if="page.canAdjust" command="adjust" divided>
                          余额调整
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </template>
              </V2TableActionColumn>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="额外开支" name="expenses">
            <el-table
              class="v2-records-table"
              :data="page.expenses"
              row-key="id"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <FinanceEmpty title="暂无额外开支" description="手机、办公、工资等开支在这里入账" />
              </template>
              <V2TableColumn kind="date" label="发生时间" width-preset="dateTime" fixed="left">
                <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
              </V2TableColumn>
              <V2TableColumn kind="text" label="分类" width-preset="identifier">
                <template #default="{ row }"
                  ><strong>{{ row.categoryName }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn kind="text" label="付款账户" width-preset="wide">
                <template #default="{ row }">{{ row.financeAccountName }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="原币金额" width-preset="standard">
                <template #default="{ row }">{{
                  formatOriginal(row.amountOriginal, row.currency)
                }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="交易汇率" width-preset="standard">
                <template #default="{ row }">{{ row.fxRateToCny }}</template>
              </V2TableColumn>
              <V2TableColumn kind="numeric" label="人民币金额" width-preset="standard">
                <template #default="{ row }">{{ formatCny(row.amountCny) }}</template>
              </V2TableColumn>
              <V2TableColumn kind="text" label="收款方" width-preset="wide">
                <template #default="{ row }">{{ row.payee || '—' }}</template>
              </V2TableColumn>
              <V2TableColumn kind="text" label="备注" width-preset="longText">
                <template #default="{ row }">{{ row.remark || '—' }}</template>
              </V2TableColumn>
            </el-table>
            <footer class="v2-records-pagination">
              <span>共 {{ page.expenseTotal }} 条</span>
              <el-pagination
                :current-page="page.expensePage"
                :page-size="page.pageSize"
                background
                layout="prev, pager, next"
                :total="page.expenseTotal"
                @current-change="page.setExpensePage"
              />
            </footer>
          </el-tab-pane>

          <el-tab-pane label="不可变流水" name="journals">
            <el-table
              class="v2-records-table"
              :data="page.journals"
              row-key="id"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <FinanceEmpty title="暂无财务流水" description="业务完成或手工记账后自动生成" />
              </template>
              <V2TableColumn kind="text" type="expand" width="52" label="明细">
                <template #default="{ row }">
                  <div class="v2-finance-lines">
                    <div v-for="line in row.lines" :key="line.id">
                      <span>{{ accountCodeLabel(line.accountCode) }}</span>
                      <strong>{{ line.direction === 'debit' ? '借' : '贷' }}</strong>
                      <span>{{ formatOriginal(line.amountOriginal, line.currency) }}</span>
                      <span>{{ formatCny(line.amountCny) }}</span>
                      <span>{{ line.memo || '—' }}</span>
                    </div>
                  </div>
                </template>
              </V2TableColumn>
              <V2TableColumn kind="identifier" label="流水号" width-preset="wide" fixed="left">
                <template #default="{ row }"
                  ><strong>{{ row.journalNo }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn kind="date" label="发生时间" width-preset="dateTime">
                <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
              </V2TableColumn>
              <V2TableColumn kind="status" label="业务类型" width-preset="wide">
                <template #default="{ row }">
                  <el-tag effect="plain">{{ journalTypeLabel(row.journalType) }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn kind="text" label="摘要" width-preset="longText" prop="summary" />
              <V2TableColumn kind="identifier" label="来源" width-preset="identifier">
                <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
              </V2TableColumn>
              <V2TableColumn kind="status" label="状态" width-preset="compact">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'posted' ? 'success' : 'info'" effect="plain">
                    {{ row.status === 'posted' ? '已发布' : '已冲销' }}
                  </el-tag>
                </template>
              </V2TableColumn>
              <V2TableActionColumn v-if="page.canAdjust" layout="single">
                <template #default="{ row }">
                  <AppButton
                    size="small"
                    variant="ghost"
                    :disabled="row.status !== 'posted' || row.journalType === 'reversal'"
                    @click="page.openReversal(row)"
                  >
                    冲销
                  </AppButton>
                </template>
              </V2TableActionColumn>
            </el-table>
            <footer class="v2-records-pagination">
              <span>共 {{ page.journalTotal }} 条</span>
              <el-pagination
                :current-page="page.journalPage"
                :page-size="page.pageSize"
                background
                layout="prev, pager, next"
                :total="page.journalTotal"
                @current-change="page.setJournalPage"
              />
            </footer>
          </el-tab-pane>

          <el-tab-pane label="关账与历史" name="periods">
            <section class="v2-finance-history">
              <article>
                <div>
                  <span>财务启用时间</span>
                  <strong>{{ formatDate(page.settings?.enabledAt) }}</strong>
                </div>
                <el-tag
                  :type="page.settings?.historyStatus === 'completed' ? 'success' : 'warning'"
                  effect="plain"
                >
                  {{ historyStatusLabel(page.settings?.historyStatus) }}
                </el-tag>
              </article>
              <p>{{ page.settings?.historyNote || '尚未填写历史状态说明' }}</p>
              <div v-if="page.canManage">
                <AppButton
                  v-if="page.settings?.historyStatus !== 'completed'"
                  variant="soft"
                  :loading="page.historyPreviewLoading"
                  @click="page.openHistoryBackfillPreview"
                >
                  预览历史回填
                </AppButton>
                <AppButton
                  v-if="
                    page.settings?.historyStatus === 'incomplete' ||
                    page.settings?.historyStatus === 'completed'
                  "
                  variant="ghost"
                  @click="page.openHistoryConfirmation"
                >
                  确认期初与旧开支
                </AppButton>
              </div>
            </section>
            <el-table
              class="v2-records-table"
              :data="page.periods"
              row-key="month"
              scrollbar-always-on
              show-overflow-tooltip
            >
              <template #empty>
                <FinanceEmpty title="暂无关账月份" description="未关账月份默认保持开放" />
              </template>
              <V2TableColumn kind="identifier" label="月份" width-preset="identifier" fixed="left">
                <template #default="{ row }"
                  ><strong>{{ row.month }}</strong></template
                >
              </V2TableColumn>
              <V2TableColumn kind="status" label="状态" width-preset="compact">
                <template #default="{ row }">
                  <el-tag :type="periodStatusType(row.status)" effect="plain">
                    {{ periodStatusLabel(row.status) }}
                  </el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn kind="date" label="关账时间" width-preset="dateTime">
                <template #default="{ row }">{{ formatDate(row.closedAt) }}</template>
              </V2TableColumn>
              <V2TableColumn kind="date" label="重开时间" width-preset="dateTime">
                <template #default="{ row }">{{ formatDate(row.reopenedAt) }}</template>
              </V2TableColumn>
              <V2TableColumn kind="text" label="重开原因" width-preset="longText">
                <template #default="{ row }">{{ row.reopenReason || '—' }}</template>
              </V2TableColumn>
              <V2TableActionColumn v-if="page.canClose" layout="single">
                <template #default="{ row }">
                  <AppButton
                    v-if="row.status === 'closed'"
                    size="small"
                    variant="ghost"
                    @click="page.openPeriod('reopen', row)"
                  >
                    重新打开
                  </AppButton>
                  <span v-else>—</span>
                </template>
              </V2TableActionColumn>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </section>
    </V2AsyncRegion>

    <V2FinanceLedgerDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { defineComponent, h, reactive } from 'vue';
import { Lock, Plus, Refresh, RefreshLeft } from '@element-plus/icons-vue';
import type { V2FinanceSupplierWallet } from './contracts';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2FinanceLedgerDrawers from './components/V2FinanceLedgerDrawers.vue';
import {
  accountCodeLabel,
  accountTypeLabel,
  amountTone,
  formatCny,
  formatDate,
  formatOriginal,
  historyStatusLabel,
  journalTypeLabel,
  periodStatusLabel,
  periodStatusType
} from './financeLedgerPresentation';
import { useFinanceLedgerPage } from './useFinanceLedgerPage';
import '@/v2/styles/records.css';
import '@/v2/styles/finance.css';

const page = reactive(useFinanceLedgerPage());

function handleWalletMutationCommand(row: V2FinanceSupplierWallet, command: unknown) {
  if (command === 'deposit' || command === 'refund' || command === 'adjust') {
    page.openWalletMutation(row, command);
  }
}

const FinanceEmpty = defineComponent({
  props: {
    title: { type: String, required: true },
    description: { type: String, required: true }
  },
  setup(props) {
    return () =>
      h('div', { class: 'v2-records-empty' }, [
        h('strong', props.title),
        h('span', props.description)
      ]);
  }
});
</script>
