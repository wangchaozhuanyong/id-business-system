<template>
  <V2FormDrawer
    v-model="page.accountDrawerVisible"
    :title="page.editingAccount ? '编辑资金账户' : '新建资金账户'"
    eyebrow="自有资金"
    description="维护账户身份、期初余额和可追溯的汇率依据"
    :confirm-loading="page.accountSubmitting"
    :dirty="page.accountDirty"
    @confirm="page.submitAccount"
  >
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <V2PanelSection heading-id="finance-account-identity" title="账户身份" step="01">
        <el-form-item label="账户名称" required>
          <el-input v-model="page.accountForm.name" maxlength="160" />
        </el-form-item>
        <el-form-item label="账户类型" required>
          <el-select
            v-model="page.accountForm.accountType"
            :disabled="Boolean(page.editingAccount)"
          >
            <el-option label="银行卡" value="bank" />
            <el-option label="现金" value="cash" />
            <el-option label="电子钱包" value="ewallet" />
            <el-option label="USDT 钱包" value="usdt_wallet" />
          </el-select>
        </el-form-item>
        <el-form-item label="币种" required>
          <el-select v-model="page.accountForm.currency" :disabled="Boolean(page.editingAccount)">
            <el-option label="CNY" value="CNY" />
            <el-option label="MYR" value="MYR" />
            <el-option label="USD" value="USD" />
            <el-option label="USDT" value="USDT" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="page.editingAccount" label="状态" required>
          <el-select v-model="page.accountForm.status">
            <el-option label="启用" value="active" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection
        v-if="!page.editingAccount"
        heading-id="finance-account-opening"
        title="期初余额与汇率"
        step="02"
      >
        <el-form-item label="期初余额" required>
          <el-input v-model="page.accountForm.openingBalance" inputmode="decimal" />
        </el-form-item>
        <template v-if="page.accountForm.currency !== 'CNY'">
          <el-form-item label="人工汇率">
            <el-input
              v-model="page.accountForm.fxRateToCny"
              inputmode="decimal"
              placeholder="留空则使用有效采集汇率"
            />
          </el-form-item>
          <el-form-item label="人工汇率原因">
            <el-input
              v-model="page.accountForm.manualRateReason"
              type="textarea"
              :rows="3"
              maxlength="500"
            />
          </el-form-item>
        </template>
      </V2PanelSection>
      <V2PanelSection
        heading-id="finance-account-remark"
        title="补充说明"
        :step="page.editingAccount ? '02' : '03'"
      >
        <el-form-item label="备注">
          <el-input v-model="page.accountForm.remark" type="textarea" :rows="3" maxlength="2000" />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>
  <V2FinanceInflowDrawer :page="page" />
  <V2FormDrawer
    v-model="page.expenseDrawerVisible"
    :title="page.editingExpense ? '更正经营开支' : '开支记账'"
    eyebrow="经营开支"
    description="按业务证据记录付款、汇率与更正原因，原始流水不会被覆盖"
    :confirm-text="page.editingExpense ? '冲销并重记' : '确认入账'"
    :confirm-loading="page.expenseSubmitting"
    :dirty="page.expenseDirty"
    @confirm="page.submitExpense"
  >
    <el-alert
      v-if="page.editingExpense"
      title="系统不会修改原始流水；确认后会冲销原流水，并按下方正确内容重新记账。"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <V2PanelSection heading-id="finance-expense-payment" title="开支与付款" step="01">
        <el-form-item label="开支分类" required>
          <el-select v-model="page.expenseForm.categoryOptionId">
            <el-option
              v-for="item in page.expenseCategories"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="付款账户" required>
          <el-select v-model="page.expenseForm.financeAccountId">
            <el-option
              v-for="item in page.accounts.filter((account) => account.status === 'active')"
              :key="item.id"
              :label="`${item.name} · ${item.currency} · ${formatOriginal(item.currentBalance, item.currency)}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="开支金额" required>
          <el-input v-model="page.expenseForm.amount" inputmode="decimal">
            <template #prepend>{{ page.selectedExpenseAccount?.currency || '币种' }}</template>
          </el-input>
        </el-form-item>
        <el-form-item label="发生时间" required>
          <el-input v-model="page.expenseForm.occurredAt" type="datetime-local" />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection
        v-if="page.selectedExpenseAccount && page.selectedExpenseAccount.currency !== 'CNY'"
        heading-id="finance-expense-rate"
        title="汇率证据"
        step="02"
      >
        <el-form-item label="人工汇率">
          <el-input
            v-model="page.expenseForm.fxRateToCny"
            inputmode="decimal"
            placeholder="留空则锁定有效采集汇率"
          />
        </el-form-item>
        <el-form-item label="人工汇率原因">
          <el-input
            v-model="page.expenseForm.manualRateReason"
            type="textarea"
            :rows="3"
            maxlength="500"
          />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection
        heading-id="finance-expense-evidence"
        title="收款与更正依据"
        :step="page.selectedExpenseAccount?.currency === 'CNY' ? '02' : '03'"
      >
        <el-form-item label="收款方">
          <el-input v-model="page.expenseForm.payee" maxlength="200" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="page.expenseForm.remark" type="textarea" :rows="3" maxlength="2000" />
        </el-form-item>
        <el-form-item v-if="page.editingExpense" label="更正原因" required>
          <el-input
            v-model="page.expenseCorrectionReason"
            type="textarea"
            :rows="3"
            maxlength="500"
          />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>
  <V2FormDrawer
    v-model="page.walletDrawerVisible"
    title="新建供应商多币种钱包"
    eyebrow="供应商资金"
    description="建立供应商、币种和期初余额的唯一资金关系"
    :confirm-loading="page.walletSubmitting"
    :dirty="page.walletDirty"
    @confirm="page.submitWallet"
  >
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <V2PanelSection heading-id="finance-wallet-identity" title="钱包归属" step="01">
        <el-form-item label="供应商" required>
          <el-select v-model="page.walletForm.supplierOptionId">
            <el-option
              v-for="item in page.supplierOptions"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="币种" required>
          <el-select v-model="page.walletForm.currency">
            <el-option label="CNY" value="CNY" />
            <el-option label="MYR" value="MYR" />
            <el-option label="USD" value="USD" />
            <el-option label="USDT" value="USDT" />
          </el-select>
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="finance-wallet-opening" title="期初资金证据" step="02">
        <el-form-item label="期初余额" required>
          <el-input v-model="page.walletForm.openingBalance" inputmode="decimal" />
        </el-form-item>
        <template v-if="page.walletForm.currency !== 'CNY'">
          <el-form-item label="人工汇率">
            <el-input
              v-model="page.walletForm.fxRateToCny"
              inputmode="decimal"
              placeholder="留空则使用有效采集汇率"
            />
          </el-form-item>
          <el-form-item label="人工汇率原因">
            <el-input
              v-model="page.walletForm.manualRateReason"
              type="textarea"
              :rows="3"
              maxlength="500"
            />
          </el-form-item>
        </template>
        <el-form-item label="期初依据" required>
          <el-input v-model="page.walletForm.reason" type="textarea" :rows="3" maxlength="500" />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <V2FinanceWalletMutationDrawer :page="page" />

  <V2FormDrawer
    v-model="page.reversalDrawerVisible"
    title="冲销并重记"
    confirm-text="确认冲销"
    :confirm-loading="page.reversalSubmitting"
    :dirty="Boolean(page.reversalReason)"
    @confirm="page.submitReversal"
  >
    <el-alert
      type="warning"
      :title="page.selectedJournal?.journalNo || '财务流水'"
      description="冲销不会删除原流水。系统会新增一笔金额相反的流水，抵消原流水对余额和损益的影响，原流水随后显示“已冲销”。如果原记录有误，冲销后请按正确业务证据重新记账。"
      show-icon
      :closable="false"
    />
    <el-form
      class="v2-horizontal-form v2-finance-drawer-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <el-form-item label="冲销原因" required>
        <el-input
          v-model="page.reversalReason"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
        />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.periodDrawerVisible"
    :title="page.periodMutationMode === 'close' ? '月度关账' : '重新打开月份'"
    :confirm-text="page.periodMutationMode === 'close' ? '确认关账' : '确认重新打开'"
    :confirm-loading="page.periodSubmitting"
    :dirty="Boolean(page.periodForm.month || page.periodForm.reason)"
    @confirm="page.submitPeriod"
  >
    <el-alert
      type="warning"
      title="关账后，该月份不能再生成新财务流水"
      description="如需修正，必须由有权限人员填写原因并重新打开月份。"
      show-icon
      :closable="false"
    />
    <el-form
      class="v2-horizontal-form v2-finance-drawer-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <el-form-item label="财务月份" required>
        <el-input
          v-model="page.periodForm.month"
          maxlength="7"
          placeholder="YYYY-MM"
          :disabled="page.periodMutationMode === 'reopen'"
        />
      </el-form-item>
      <el-form-item v-if="page.periodMutationMode === 'reopen'" label="重新打开原因" required>
        <el-input
          v-model="page.periodForm.reason"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
        />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.historyDrawerVisible"
    :title="historyDrawerTitle"
    :confirm-text="page.historyDrawerMode === 'confirm' ? '确认完整' : '重新开启核对'"
    :confirm-loading="page.historySubmitting"
    :confirm-disabled-reason="page.historyConfirmationDisabledReason"
    :dirty="page.historyDrawerDirty"
    @confirm="page.submitHistoryDrawer"
  >
    <template v-if="page.historyDrawerMode === 'confirm'">
      <el-alert
        type="warning"
        title="这是生命周期利润完整性的人工确认"
        description="下方为本次确认的实时快照；即使数量为 0，也必须代表明确核对后的业务结论。"
        show-icon
        :closable="false"
      />
      <div
        v-if="page.historyConfirmationPreview"
        class="v2-finance-history-preview v2-finance-confirmation-preview"
      >
        <dl>
          <div>
            <dt>自有资金账户</dt>
            <dd>
              {{ page.historyConfirmationPreview.financeAccounts.count }} 个 · 期初
              {{ formatCny(page.historyConfirmationPreview.financeAccounts.openingBalanceCny) }} ·
              当前
              {{ formatCny(page.historyConfirmationPreview.financeAccounts.currentBalanceCny) }}
            </dd>
          </div>
          <div>
            <dt>卡商余额</dt>
            <dd>
              {{ page.historyConfirmationPreview.supplierWallets.count }} 个 · 期初
              {{ formatCny(page.historyConfirmationPreview.supplierWallets.openingBalanceCny) }} ·
              当前
              {{ formatCny(page.historyConfirmationPreview.supplierWallets.currentBalanceCny) }}
            </dd>
          </div>
          <div>
            <dt>系统外旧开支</dt>
            <dd>
              {{ page.historyConfirmationPreview.historicalExpenses.count }} 条 · 合计
              {{ formatCny(page.historyConfirmationPreview.historicalExpenses.amountCny) }}
            </dd>
          </div>
        </dl>
        <p>
          财务启用时间
          {{
            formatDate(page.historyConfirmationPreview.enabledAt)
          }}；提交时系统会重新校验以上快照。
        </p>
      </div>
      <el-form
        class="v2-horizontal-form v2-finance-drawer-form"
        label-position="left"
        label-width="126px"
        require-asterisk-position="right"
      >
        <el-form-item label="核对清单" required>
          <div class="v2-finance-history-checklist">
            <el-checkbox v-model="page.historyChecklist.financeAccountsConfirmed">
              已核对全部自有资金账户；0 个表示期初与当前资金均确认为 0
            </el-checkbox>
            <el-checkbox v-model="page.historyChecklist.supplierBalancesConfirmed">
              已核对全部卡商期初余额和当前余额
            </el-checkbox>
            <el-checkbox v-model="page.historyChecklist.historicalExpensesConfirmed">
              已补录全部系统外旧开支；0 条表示确认没有遗漏开支
            </el-checkbox>
          </div>
        </el-form-item>
        <el-form-item label="确认说明" required>
          <el-input
            v-model="page.historyNote"
            type="textarea"
            :rows="5"
            maxlength="1000"
            show-word-limit
            placeholder="例如：已核对 2026-07-29 期初账户、卡商余额和全部旧开支"
          />
        </el-form-item>
      </el-form>
    </template>
    <template v-else>
      <el-alert
        type="warning"
        title="重新开启后，财务历史状态将恢复为待人工确认"
        description="原确认记录会保留，新原因会单独写入审计日志。重新核对完成前，生命周期利润将继续提示历史数据不完整。"
        show-icon
        :closable="false"
      />
      <el-form
        class="v2-horizontal-form v2-finance-drawer-form"
        label-position="left"
        label-width="126px"
        require-asterisk-position="right"
      >
        <el-form-item label="重新核对原因" required>
          <el-input
            v-model="page.historyReopenReason"
            type="textarea"
            :rows="5"
            maxlength="1000"
            show-word-limit
            placeholder="例如：原确认说明为测试值，需重新核对自有资金和系统外旧开支"
          />
        </el-form-item>
      </el-form>
    </template>
  </V2FormDrawer>

  <V2ConfirmDialog
    v-model="page.historyPreviewVisible"
    title="历史回填影响预览"
    message=""
    confirm-text="确认并执行回填"
    :confirm-loading="page.historySubmitting"
    :confirm-disabled-reason="page.historyPreviewConfirmDisabledReason"
    @confirm="page.runHistoryBackfill"
  >
    <div v-if="page.historyPreview" class="v2-finance-history-preview">
      <el-alert
        type="warning"
        title="历史金额将按 CNY、汇率 1 回填"
        :description="`预览截止 ${formatDate(page.historyPreview.asOf)}；确认前请核对下方影响，执行时新增数据可能使数量变化。`"
        show-icon
        :closable="false"
      />
      <dl>
        <div v-for="item in historyPreviewRows" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd>
            建账 {{ item.value.willCreateCount }} · 已有跳过 {{ item.value.skippedExistingCount }} ·
            零金额跳过
            {{ item.value.skippedZeroAmountCount }}
          </dd>
        </div>
      </dl>
      <p>
        将补齐 CNY 汇率快照：ID {{ page.historyPreview.fxSnapshotUpdates.accounts }}、礼品卡
        {{ page.historyPreview.fxSnapshotUpdates.giftCards }}、订单
        {{ page.historyPreview.fxSnapshotUpdates.orders }}。
      </p>
      <template v-if="page.historyPreview.assetOpening.willCreate">
        <dl aria-label="资产期初差额">
          <div
            v-for="adjustment in page.historyPreview.assetOpening.adjustments"
            :key="adjustment.accountCode"
          >
            <dt>{{ historyAssetOpeningAccountLabel(adjustment.accountCode) }}</dt>
            <dd>
              {{ historyAssetOpeningDirectionLabel(adjustment.direction) }}
              {{ formatCny(adjustment.amountCny) }}
            </dd>
          </div>
        </dl>
        <p>
          将生成 1 张期初流水、{{ page.historyPreview.assetOpening.journalLineCount }}
          条分录；资产调整合计
          {{ formatCny(page.historyPreview.assetOpening.adjustmentTotalCny) }}。
        </p>
      </template>
      <p v-else>无需生成资产期初差额流水。</p>
      <p>回填后状态仍为“待人工确认”，不会自动宣称历史数据完整。</p>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import V2FinanceInflowDrawer from './V2FinanceInflowDrawer.vue';
import V2FinanceWalletMutationDrawer from './V2FinanceWalletMutationDrawer.vue';
import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2FinanceCurrency } from '../contracts';
import {
  formatCny,
  formatDate,
  historyAssetOpeningAccountLabel,
  historyAssetOpeningDirectionLabel
} from '../financeLedgerPresentation';
import { useFinanceLedgerPage } from '../useFinanceLedgerPage';

const { page } = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();

const historyPreviewRows = computed(() => {
  const summary = page.historyPreview?.summary;
  if (!summary) return [];
  return [
    { label: '历史订单', value: summary.orders },
    { label: 'ID 报损', value: summary.accountLosses },
    { label: '礼品卡赎回', value: summary.redeemedGiftCards },
    { label: '礼品卡撤回', value: summary.withdrawnGiftCards }
  ];
});

const historyDrawerTitle = computed(() =>
  page.historyDrawerMode === 'confirm' ? '确认历史数据完整性' : '重新核对历史数据'
);

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}
</script>
