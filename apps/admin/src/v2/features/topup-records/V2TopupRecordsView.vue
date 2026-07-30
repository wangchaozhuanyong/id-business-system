<template>
  <section class="v2-records-page v2-topup-records">
    <section class="v2-topup-records-tabs" aria-label="加卡记录视图">
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="加卡记录" name="giftCards" />
        <el-tab-pane label="余额变动" name="ledger" />
        <el-tab-pane v-if="canViewSupplierFunds" label="加卡供应商" name="suppliers" />
        <el-tab-pane v-if="canViewSupplierFunds" label="付款记录" name="payments" />
      </el-tabs>
    </section>

    <section
      v-if="filters.accountId && (activeTab === 'giftCards' || activeTab === 'ledger')"
      class="v2-topup-records-scope"
      aria-label="当前 ID 记录范围"
    >
      <div>
        <span>当前只显示</span>
        <div class="v2-topup-records-scope__title">
          <strong>{{ filters.accountLabel || '指定 ID' }}</strong>
          <FeatureHelp
            title="记录筛选范围"
            text="完整加卡和余额流水均按该 ID 筛选。"
            placement="right"
          />
        </div>
      </div>
      <AppButton size="small" variant="ghost" title="清除 ID 筛选" @click="clearAccountScope">
        <el-icon><Close /></el-icon>
        清除
      </AppButton>
    </section>

    <section
      v-if="activeTab === 'giftCards' || activeTab === 'ledger'"
      class="v2-topup-records-toolbar"
      aria-label="加卡记录筛选"
    >
      <el-input
        v-model="filters.keyword"
        clearable
        placeholder="卡片名称、礼品卡尾号、ID、供应商"
        aria-label="搜索加卡记录"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select
        v-if="activeTab === 'giftCards'"
        v-model="giftCardQuery.status"
        clearable
        placeholder="全部状态"
        aria-label="筛选礼品卡状态"
        @change="handleFilterChange"
      >
        <el-option label="加卡成功" value="credited" />
        <el-option label="被赎回" value="redeemed" />
        <el-option label="已撤回" value="withdrawn" />
      </el-select>
      <el-select
        v-else
        v-model="ledgerQuery.entryType"
        clearable
        placeholder="全部变动"
        aria-label="筛选余额变动类型"
        @change="handleFilterChange"
      >
        <el-option label="礼品卡入账" value="gift_card_credit" />
        <el-option label="被赎回扣减" value="gift_card_redeemed" />
        <el-option label="撤回扣减" value="gift_card_withdrawal" />
        <el-option label="ID 永久报损" value="account_loss" />
      </el-select>
      <V2FilterDisclosure>
        <el-select
          v-if="activeTab === 'giftCards'"
          v-model="filters.cardNameOptionId"
          clearable
          placeholder="全部卡片名称"
          aria-label="筛选卡片名称"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in cardNameOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="filters.countryOptionId"
          clearable
          placeholder="全部国家"
          aria-label="筛选国家"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in countryOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="filters.supplierOptionId"
          clearable
          placeholder="全部供应商"
          aria-label="筛选供应商"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in topupSupplierOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-date-picker
          v-model="filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="至"
          aria-label="筛选变动日期"
          @change="handleFilterChange"
        />
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="应用筛选" @click="handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新数据" :disabled="activeLoading" @click="loadActiveTab">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2TopupRecordsTables
      v-if="activeTab === 'giftCards' || activeTab === 'ledger'"
      v-model:gift-card-page="giftCardQuery.page"
      v-model:gift-card-page-size="giftCardQuery.pageSize"
      v-model:ledger-page="ledgerQuery.page"
      v-model:ledger-page-size="ledgerQuery.pageSize"
      :active-tab="activeTab"
      :active-loading="activeLoading"
      :is-initial-loading="isInitialLoading"
      :active-resolved="activeResolved"
      :active-error="activeError"
      :gift-card-loading="giftCardLoading"
      :gift-cards="giftCards"
      :gift-card-total="giftCardTotal"
      :ledger-loading="ledgerLoading"
      :ledger-entries="ledgerEntries"
      :ledger-total="ledgerTotal"
      :can-adjust-balance="canAdjustBalance"
      :can-reassign-supplier="canReassignSupplier"
      @retry="loadActiveTab"
      @reset="resetFilters"
      @gift-card-sort-change="handleGiftCardSortChange"
      @ledger-sort-change="handleLedgerSortChange"
      @gift-card-page-change="handleGiftCardPageChange"
      @gift-card-page-size-change="handleGiftCardPageSizeChange"
      @ledger-page-change="handleLedgerPageChange"
      @ledger-page-size-change="handleLedgerPageSizeChange"
      @edit-metadata="openMetadataDrawer"
      @reassign-supplier="openSupplierDrawer"
      @reverse="openReversalConfirmation"
    />

    <V2TopupSupplierFundsPanel
      v-else-if="activeTab === 'suppliers'"
      :can-manage="canManageSupplierFunds"
    />

    <V2TopupSupplierPaymentsPanel
      v-else
      :can-manage="canManageSupplierFunds"
      :suppliers="topupSupplierOptions"
    />

    <V2FormDrawer
      v-model="metadataDrawerVisible"
      title="修改加卡记录"
      confirm-text="保存非账务信息"
      :confirm-disabled-reason="metadataDisabledReason"
      :confirm-loading="metadataSubmitting"
      :dirty="metadataDirty"
      @confirm="confirmMetadata"
    >
      <el-form
        v-if="selectedGiftCard"
        ref="metadataFormRef"
        class="v2-topup-records-metadata v2-horizontal-form"
        :model="metadataForm"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <section>
          <span>礼品卡</span>
          <strong>{{ selectedGiftCard.code }}</strong>
          <small>{{ selectedGiftCard.account.appleIdMasked }}</small>
        </section>
        <el-alert
          title="面值、汇率、成本和余额快照不可修改；账务错误请撤回后重新入账"
          type="warning"
          show-icon
          :closable="false"
        />
        <el-form-item label="备注">
          <el-input
            v-model="metadataForm.remark"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="记录供应商复核或业务说明"
          />
        </el-form-item>
      </el-form>
    </V2FormDrawer>

    <V2FormDrawer
      v-model="supplierDrawerVisible"
      title="更正加卡供应商"
      confirm-text="确认更正供应商"
      :confirm-disabled-reason="supplierDisabledReason"
      :confirm-loading="supplierSubmitting"
      :dirty="supplierDirty"
      @confirm="confirmSupplierReassignment"
    >
      <el-form
        v-if="selectedGiftCard"
        ref="supplierFormRef"
        class="v2-topup-records-metadata v2-horizontal-form"
        :model="supplierForm"
        label-position="left"
        label-width="104px"
        require-asterisk-position="right"
      >
        <section>
          <span>礼品卡</span>
          <strong>{{ selectedGiftCard.code }}</strong>
          <small>原供应商：{{ selectedGiftCard.supplier?.name || '未设置' }}</small>
        </section>
        <el-alert
          :title="
            selectedGiftCard.supplierFunding
              ? '切账后更正会在同一事务中返还原供应商并扣减新供应商'
              : '切账前历史记录只更正归属，不生成供应商资金流水'
          "
          type="warning"
          show-icon
          :closable="false"
        />
        <el-form-item label="新供应商" prop="supplierOptionId" required>
          <el-select v-model="supplierForm.supplierOptionId" placeholder="请选择新的加卡供应商">
            <el-option
              v-for="option in topupSupplierOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
              :disabled="option.id === selectedGiftCard.supplierOptionId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="更正原因" prop="reason" required>
          <el-input
            v-model="supplierForm.reason"
            type="textarea"
            :rows="4"
            minlength="2"
            maxlength="500"
            show-word-limit
            placeholder="必填，说明供应商归属更正依据"
          />
        </el-form-item>
      </el-form>
    </V2FormDrawer>

    <V2ConfirmDialog
      v-model="reversalDialogVisible"
      :title="reversalDialogTitle"
      :message="reversalMessage"
      :confirm-text="reversalConfirmText"
      :confirm-loading="reversalSubmitting"
      :confirm-disabled-reason="reversalDisabledReason"
      danger
      @confirm="confirmReversal"
    >
      <div class="v2-topup-records-reversal">
        <p>{{ reversalMessage }}</p>
        <el-alert
          title="系统会新增一笔反向流水并保留原始入账，不会删除或覆盖历史记录"
          type="warning"
          show-icon
          :closable="false"
        />
        <el-checkbox v-if="showAccountLossOption" v-model="reportAccountLoss">
          同时报损该 ID（永久冻结）
        </el-checkbox>
        <el-alert
          v-if="showAccountLossOption && reportAccountLoss"
          title="系统会先扣除当前卡片，再永久清零该 ID 的剩余余额和人民币成本；报损后无法撤销或恢复"
          type="error"
          show-icon
          :closable="false"
        />
        <el-form
          ref="reversalFormRef"
          class="v2-horizontal-form"
          :model="reversalFormModel"
          :rules="reversalRules"
          label-position="left"
          label-width="88px"
          require-asterisk-position="right"
          status-icon
          scroll-to-error
          :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
        >
          <el-form-item label="处理原因" prop="reason">
            <el-input
              v-model="reversalReason"
              type="textarea"
              :rows="3"
              minlength="2"
              maxlength="500"
              show-word-limit
              placeholder="必填，记录供应商反馈或撤回依据"
            />
          </el-form-item>
        </el-form>
      </div>
    </V2ConfirmDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormInstance } from 'element-plus';
import { Close, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import V2TopupRecordsTables from './components/V2TopupRecordsTables.vue';
import V2TopupSupplierFundsPanel from './components/V2TopupSupplierFundsPanel.vue';
import V2TopupSupplierPaymentsPanel from './components/V2TopupSupplierPaymentsPanel.vue';
import { topupRecordReversalRules as reversalRules } from './topup-records-form';
import { useTopupRecordsPage } from './useTopupRecordsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/topup-records.css';

const {
  canAdjustBalance,
  canViewSupplierFunds,
  canManageSupplierFunds,
  canReassignSupplier,
  activeTab,
  cardNameOptions,
  countryOptions,
  topupSupplierOptions,
  giftCards,
  giftCardTotal,
  giftCardLoading,
  ledgerEntries,
  ledgerTotal,
  ledgerLoading,
  metadataDrawerVisible,
  metadataSubmitting,
  supplierDrawerVisible,
  supplierSubmitting,
  selectedGiftCard,
  reversalDialogVisible,
  reversalSubmitting,
  reversalReason,
  reportAccountLoss,
  showAccountLossOption,
  filters,
  giftCardQuery,
  ledgerQuery,
  metadataForm,
  supplierForm,
  metadataDisabledReason,
  supplierDisabledReason,
  activeLoading,
  activeError,
  activeResolved,
  reversalDialogTitle,
  reversalConfirmText,
  reversalMessage,
  reversalDisabledReason,
  isInitialLoading,
  loadActiveTab,
  handleTabChange,
  handleSearch,
  handleFilterChange,
  resetFilters,
  clearAccountScope,
  handleGiftCardPageSizeChange,
  handleLedgerPageSizeChange,
  handleGiftCardPageChange,
  handleLedgerPageChange,
  handleGiftCardSortChange,
  handleLedgerSortChange,
  openMetadataDrawer,
  submitMetadata,
  openSupplierDrawer,
  submitSupplierReassignment,
  openReversalConfirmation,
  submitReversal
} = useTopupRecordsPage();

const metadataFormRef = ref<FormInstance>();
const supplierFormRef = ref<FormInstance>();
const reversalFormRef = ref<FormInstance>();
const metadataDirty = computed(
  () =>
    Boolean(selectedGiftCard.value) &&
    metadataForm.remark !== (selectedGiftCard.value?.remark ?? '')
);
const supplierDirty = computed(
  () =>
    Boolean(selectedGiftCard.value) &&
    (supplierForm.supplierOptionId !== (selectedGiftCard.value?.supplierOptionId ?? '') ||
      Boolean(supplierForm.reason.trim()))
);
const reversalFormModel = computed(() => ({ reason: reversalReason.value }));

async function confirmMetadata() {
  if (metadataDisabledReason.value || !(await validateV2Form(metadataFormRef.value))) return;
  await submitMetadata();
}

async function confirmSupplierReassignment() {
  if (supplierDisabledReason.value || !(await validateV2Form(supplierFormRef.value))) return;
  await submitSupplierReassignment();
}

async function confirmReversal() {
  if (reversalDisabledReason.value || !(await validateV2Form(reversalFormRef.value))) return;
  await submitReversal();
}
</script>
