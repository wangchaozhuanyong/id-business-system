<template>
  <section class="v2-records-page v2-topup-records">
    <section class="v2-topup-records-tabs" aria-label="加卡记录视图">
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="加卡记录" name="giftCards" />
        <el-tab-pane label="余额变动" name="ledger" />
      </el-tabs>
    </section>

    <section v-if="filters.accountId" class="v2-topup-records-scope" aria-label="当前 ID 记录范围">
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

    <section class="v2-topup-records-toolbar" aria-label="加卡记录筛选">
      <el-input
        v-model="filters.keyword"
        clearable
        placeholder="礼品卡尾号、ID、供应商"
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
      @retry="loadActiveTab"
      @reset="resetFilters"
      @gift-card-sort-change="handleGiftCardSortChange"
      @ledger-sort-change="handleLedgerSortChange"
      @gift-card-page-change="handleGiftCardPageChange"
      @gift-card-page-size-change="handleGiftCardPageSizeChange"
      @ledger-page-change="handleLedgerPageChange"
      @ledger-page-size-change="handleLedgerPageSizeChange"
      @edit-metadata="openMetadataDrawer"
      @reverse="openReversalConfirmation"
    />

    <V2FormDrawer
      v-model="metadataDrawerVisible"
      title="修改加卡记录"
      confirm-text="保存非账务信息"
      :confirm-disabled="!selectedGiftCard"
      :confirm-loading="metadataSubmitting"
      @confirm="submitMetadata"
    >
      <div v-if="selectedGiftCard" class="v2-topup-records-metadata">
        <section>
          <span>礼品卡</span>
          <strong>{{ selectedGiftCard.codeMasked }}</strong>
          <small>{{ selectedGiftCard.account.appleIdMasked }}</small>
        </section>
        <el-alert
          title="面值、汇率、成本和余额快照不可修改；账务错误请撤回后重新入账"
          type="warning"
          show-icon
          :closable="false"
        />
        <label>
          <span>供应商</span>
          <el-select
            v-model="metadataForm.supplierOptionId"
            clearable
            placeholder="未设置"
            aria-label="修改供应商"
          >
            <el-option
              v-for="option in topupSupplierOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </label>
        <label>
          <span>备注</span>
          <el-input
            v-model="metadataForm.remark"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="记录供应商复核或业务说明"
          />
        </label>
      </div>
    </V2FormDrawer>

    <V2ConfirmDialog
      v-model="reversalDialogVisible"
      :title="reversalDialogTitle"
      :message="reversalMessage"
      :confirm-text="reversalConfirmText"
      :confirm-loading="reversalSubmitting"
      :confirm-disabled="reversalReason.trim().length < 2"
      danger
      @confirm="submitReversal"
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
        <label>
          <span>处理原因</span>
          <el-input
            v-model="reversalReason"
            type="textarea"
            :rows="3"
            minlength="2"
            maxlength="500"
            show-word-limit
            placeholder="必填，记录供应商反馈或撤回依据"
          />
        </label>
      </div>
    </V2ConfirmDialog>
  </section>
</template>

<script setup lang="ts">
import { Close, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2TopupRecordsTables from './components/V2TopupRecordsTables.vue';
import { useTopupRecordsPage } from './useTopupRecordsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/topup-records.css';

const {
  canAdjustBalance,
  activeTab,
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
  activeLoading,
  activeError,
  activeResolved,
  reversalDialogTitle,
  reversalConfirmText,
  reversalMessage,
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
  openReversalConfirmation,
  submitReversal
} = useTopupRecordsPage();
</script>
