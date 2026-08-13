<template>
  <V2FormDrawer
    v-model="page.walletMutationDrawerVisible"
    :title="drawerTitle"
    eyebrow="供应商资金"
    description="记录供应商钱包与自有资金账户之间的真实资金变化"
    confirm-text="确认入账"
    :confirm-loading="page.walletMutationSubmitting"
    :dirty="page.walletMutationDirty"
    @confirm="page.submitWalletMutation"
  >
    <V2DetailSummary
      heading-id="finance-wallet-mutation-summary"
      eyebrow="当前钱包"
      :title="page.selectedWallet?.supplierName || '未选择供应商钱包'"
      :description="page.selectedWallet?.currency || '—'"
      :metrics="[
        {
          label: '当前余额',
          value: page.selectedWallet
            ? formatOriginal(page.selectedWallet.currentBalance, page.selectedWallet.currency)
            : '—'
        }
      ]"
    />
    <el-form
      class="v2-horizontal-form v2-finance-drawer-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <V2PanelSection
        heading-id="finance-wallet-mutation-amount"
        :title="page.walletMutationMode === 'adjust' ? '余额调整' : '收付款信息'"
        step="01"
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
        <el-form-item v-if="page.walletMutationMode === 'deposit'" label="卡商入账金额">
          <el-input
            v-model="page.walletMutationForm.creditedAmount"
            inputmode="decimal"
            placeholder="留空则等于付款金额"
          />
        </el-form-item>
        <el-form-item v-if="page.walletMutationMode === 'adjust'" label="调整后余额" required>
          <el-input v-model="page.walletMutationForm.targetBalance" inputmode="decimal" />
        </el-form-item>
        <el-form-item v-if="page.walletMutationMode !== 'adjust'" label="发生时间" required>
          <el-input v-model="page.walletMutationForm.occurredAt" type="datetime-local" />
        </el-form-item>
      </V2PanelSection>

      <V2PanelSection
        v-if="page.walletMutationMode === 'deposit'"
        heading-id="finance-wallet-mutation-network"
        title="链上证据"
        step="02"
        help="USDT 等链上充值可记录手续费、网络和交易哈希"
      >
        <el-form-item label="网络手续费">
          <el-input v-model="page.walletMutationForm.networkFeeAmount" inputmode="decimal" />
        </el-form-item>
        <el-form-item label="网络">
          <el-input v-model="page.walletMutationForm.network" maxlength="40" />
        </el-form-item>
        <el-form-item label="交易哈希">
          <el-input v-model="page.walletMutationForm.transactionHash" maxlength="180" />
        </el-form-item>
      </V2PanelSection>

      <V2PanelSection
        heading-id="finance-wallet-mutation-evidence"
        title="汇率与入账依据"
        :step="page.walletMutationMode === 'deposit' ? '03' : '02'"
      >
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
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2FinanceCurrency } from '../contracts';
import { useFinanceLedgerPage } from '../useFinanceLedgerPage';

const { page } = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();

const drawerTitle = computed(() => {
  const action =
    page.walletMutationMode === 'deposit'
      ? '供应商充值'
      : page.walletMutationMode === 'refund'
        ? '供应商退款'
        : '供应商余额调整';
  return `${action}${page.selectedWallet ? ` · ${page.selectedWallet.supplierName}` : ''}`;
});

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}
</script>
