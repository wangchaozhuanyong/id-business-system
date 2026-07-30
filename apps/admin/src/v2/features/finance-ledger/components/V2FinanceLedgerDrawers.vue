<template>
  <V2FormDrawer
    v-model="page.accountDrawerVisible"
    :title="page.editingAccount ? '编辑资金账户' : '新建资金账户'"
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
      <el-form-item label="账户名称" required>
        <el-input v-model="page.accountForm.name" maxlength="160" />
      </el-form-item>
      <el-form-item label="账户类型" required>
        <el-select v-model="page.accountForm.accountType" :disabled="Boolean(page.editingAccount)">
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
          <el-option label="USDT" value="USDT" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="!page.editingAccount" label="期初余额" required>
        <el-input v-model="page.accountForm.openingBalance" inputmode="decimal" />
      </el-form-item>
      <template v-if="!page.editingAccount && page.accountForm.currency !== 'CNY'">
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
      <el-form-item v-if="page.editingAccount" label="状态" required>
        <el-select v-model="page.accountForm.status">
          <el-option label="启用" value="active" />
          <el-option label="停用" value="disabled" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="page.accountForm.remark" type="textarea" :rows="3" maxlength="2000" />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.expenseDrawerVisible"
    title="记录额外经营开支"
    confirm-text="确认入账"
    :confirm-loading="page.expenseSubmitting"
    :dirty="page.expenseDirty"
    @confirm="page.submitExpense"
  >
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
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
      <template
        v-if="page.selectedExpenseAccount && page.selectedExpenseAccount.currency !== 'CNY'"
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
      </template>
      <el-form-item label="收款方">
        <el-input v-model="page.expenseForm.payee" maxlength="200" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="page.expenseForm.remark" type="textarea" :rows="3" maxlength="2000" />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.walletDrawerVisible"
    title="新建供应商多币种钱包"
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
          <el-option label="USDT" value="USDT" />
        </el-select>
      </el-form-item>
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
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.walletMutationDrawerVisible"
    :title="walletMutationTitle"
    confirm-text="确认入账"
    :confirm-loading="page.walletMutationSubmitting"
    :dirty="page.walletMutationDirty"
    @confirm="page.submitWalletMutation"
  >
    <el-alert
      :title="`${page.selectedWallet?.supplierName || ''} · ${page.selectedWallet?.currency || ''}`"
      :description="`当前余额 ${page.selectedWallet ? formatOriginal(page.selectedWallet.currentBalance, page.selectedWallet.currency) : '—'}`"
      type="info"
      :closable="false"
    />
    <el-form
      class="v2-horizontal-form v2-finance-drawer-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <el-form-item
        v-if="page.walletMutationMode !== 'adjust'"
        :label="page.walletMutationMode === 'deposit' ? '付款账户' : '收款账户'"
        required
      >
        <el-select v-model="page.walletMutationForm.financeAccountId">
          <el-option
            v-for="item in page.matchingFinanceAccounts"
            :key="item.id"
            :label="`${item.name} · ${formatOriginal(item.currentBalance, item.currency)}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="page.walletMutationMode !== 'adjust'"
        :label="page.walletMutationMode === 'deposit' ? '实际付款金额' : '退款金额'"
        required
      >
        <el-input v-model="page.walletMutationForm.amount" inputmode="decimal" />
      </el-form-item>
      <template v-if="page.walletMutationMode === 'deposit'">
        <el-form-item label="卡商入账金额">
          <el-input
            v-model="page.walletMutationForm.creditedAmount"
            inputmode="decimal"
            placeholder="留空则等于付款金额"
          />
        </el-form-item>
        <el-form-item label="网络手续费">
          <el-input v-model="page.walletMutationForm.networkFeeAmount" inputmode="decimal" />
        </el-form-item>
        <el-form-item label="网络">
          <el-input v-model="page.walletMutationForm.network" maxlength="40" />
        </el-form-item>
        <el-form-item label="交易哈希">
          <el-input v-model="page.walletMutationForm.transactionHash" maxlength="180" />
        </el-form-item>
      </template>
      <el-form-item v-if="page.walletMutationMode === 'adjust'" label="调整后余额" required>
        <el-input v-model="page.walletMutationForm.targetBalance" inputmode="decimal" />
      </el-form-item>
      <el-form-item v-if="page.walletMutationMode !== 'adjust'" label="发生时间" required>
        <el-input v-model="page.walletMutationForm.occurredAt" type="datetime-local" />
      </el-form-item>
      <template v-if="page.selectedWallet?.currency !== 'CNY'">
        <el-form-item label="人工汇率">
          <el-input
            v-model="page.walletMutationForm.fxRateToCny"
            inputmode="decimal"
            placeholder="留空则锁定有效采集汇率"
          />
        </el-form-item>
        <el-form-item label="人工汇率原因">
          <el-input
            v-model="page.walletMutationForm.manualRateReason"
            type="textarea"
            :rows="3"
            maxlength="500"
          />
        </el-form-item>
      </template>
      <el-form-item v-if="page.walletMutationMode !== 'deposit'" label="操作原因" required>
        <el-input
          v-model="page.walletMutationForm.reason"
          type="textarea"
          :rows="3"
          maxlength="500"
        />
      </el-form-item>
      <el-form-item v-if="page.walletMutationMode === 'deposit'" label="备注">
        <el-input
          v-model="page.walletMutationForm.remark"
          type="textarea"
          :rows="3"
          maxlength="2000"
        />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

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
      description="已发布账务不能编辑或删除。冲销后，请按正确业务证据重新记账。"
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
    title="确认历史数据完整性"
    confirm-text="确认完整"
    :confirm-loading="page.historySubmitting"
    :dirty="Boolean(page.historyNote)"
    @confirm="page.confirmHistory"
  >
    <el-alert
      type="warning"
      title="这是生命周期利润完整性的人工确认"
      description="确认前必须已经核对自有资金、卡商期初余额，并补录系统外历史开支。"
      show-icon
      :closable="false"
    />
    <el-form
      class="v2-horizontal-form v2-finance-drawer-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
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
      <p>回填后状态仍为“待人工确认”，不会自动宣称历史数据完整。</p>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2FinanceCurrency } from '../contracts';
import { formatDate } from '../financeLedgerPresentation';
import { useFinanceLedgerPage } from '../useFinanceLedgerPage';

const { page } = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();

const walletMutationTitle = computed(() => {
  const action =
    page.walletMutationMode === 'deposit'
      ? '供应商充值'
      : page.walletMutationMode === 'refund'
        ? '供应商退款'
        : '供应商余额调整';
  return `${action}${page.selectedWallet ? ` · ${page.selectedWallet.supplierName}` : ''}`;
});

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

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix = currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : '₮';
  return `${prefix}${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}
</script>
