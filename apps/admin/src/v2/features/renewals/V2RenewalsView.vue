<template>
  <section class="v2-records-page">
    <V2RenewalsOverview :page="page" />
    <V2RenewalsToolbar :page="page" />
    <V2RenewalsList :page="page" />
    <V2AsyncRegion
      v-if="isAdmin"
      variant="section"
      skeleton="table"
      :phase="bankWarnings.phase.value"
      :error="bankWarnings.error.value ? getApiErrorMessage(bankWarnings.error.value) : ''"
      loading-title="正在加载银充续费提醒"
      @retry="bankWarnings.refresh"
    >
      <section class="v2-records-list bank-recharge-renewals" aria-label="银充续费提醒">
        <header>
          <V2SectionHeading title="银充续费提醒">
            <template #actions>
              <span>即将到期 {{ bankWarnings.data.value?.upcomingCount ?? 0 }}</span>
              <span>已到期 {{ bankWarnings.data.value?.expiredCount ?? 0 }}</span>
              <AppButton variant="ghost" size="small" @click="bankWarnings.refresh">刷新</AppButton>
            </template>
          </V2SectionHeading>
        </header>
        <p v-if="!bankWarnings.data.value?.items.length" class="v2-records-empty">
          当前没有银充续费提醒
        </p>
        <ul v-else class="bank-recharge-renewal-list">
          <li v-for="item in bankWarnings.data.value.items" :key="item.id">
            <strong>{{ item.customerName }}</strong>
            <span>{{ item.accountMasked }}</span>
            <span>{{ item.orderNo }}</span>
            <span>{{ formatV2DateTime(item.dueAt) }}</span>
            <el-tag :type="item.warningState === 'expired' ? 'danger' : 'warning'" effect="plain">{{
              item.warningState === 'expired' ? '已到期' : '即将到期'
            }}</el-tag>
            <RouterLink to="/v2/auto-recharge/bank-orders">查看银充订单</RouterLink>
          </li>
        </ul>
        <p v-if="(bankWarnings.data.value?.totalCount ?? 0) > 100" class="bank-recharge-form-note">
          当前显示最早到期的 100 条；完整订单请在银充订单查看。
        </p>
      </section>
    </V2AsyncRegion>

    <V2RenewalWarningSettingsDialog
      v-model="page.warningSettingsVisible"
      v-model:warning-days="page.warningDaysInput"
      :settings="page.warningSettings"
      :loading="page.warningSettingsLoading"
      :saving="page.warningSettingsSaving"
      :error="page.warningSettingsError"
      :can-manage="page.canManageWarning"
      @save="page.saveWarningSettings"
    />

    <V2RenewalOrderDrawer
      v-model="page.drawerVisible"
      v-model:confirmation-visible="page.confirmationVisible"
      v-model:category-option-id="page.form.categoryOptionId"
      v-model:service-option-id="page.form.serviceOptionId"
      v-model:settlement-platform-option-id="page.form.settlementPlatformOptionId"
      v-model:platform-order-no="page.form.platformOrderNo"
      v-model:received-amount="page.form.receivedAmount"
      v-model:target-profit-rate="page.form.targetProfitRate"
      v-model:balance-amount="page.form.balanceAmount"
      v-model:opened-at="page.form.openedAt"
      v-model:due-at="page.form.dueAt"
      v-model:remark="page.form.remark"
      :renewal="page.selectedRenewal"
      :categories="page.availableCategories"
      :services="page.categoryServices"
      :settlement-platforms="page.options.settlementPlatforms"
      :selected-service="page.selectedManualService"
      :options-loading="page.optionsLoading"
      :options-error="page.optionsError"
      :submitting="page.submitting"
      :submit-disabled-reason="page.renewalSubmitDisabledReason"
      :platform-fee-preview="page.platformFeePreview"
      :estimated-balance-cost-preview="page.estimatedBalanceCostPreview"
      :estimated-profit-preview="page.estimatedProfitPreview"
      :estimated-profit-rate-preview="page.estimatedProfitRatePreview"
      :suggested-received="page.suggestedReceived"
      :recommendation-applied="page.recommendationApplied"
      :applied-suggested-cny="page.appliedSuggestedCny"
      :balance-after-preview="page.balanceAfterPreview"
      :confirmation-message="page.confirmationMessage"
      @opened-at-change="page.handleRenewalOpenedAtChange"
      @category-change="page.handleRenewalCategoryChange"
      @settlement-platform-change="page.handleSettlementPlatformChange"
      @apply-suggested="page.applySuggestedReceivedAmount"
      @undo-suggested="page.undoSuggestedReceivedAmount"
      @manual-price-input="page.handleManualPriceInput"
      @open-confirmation="page.openConfirmation"
      @submit="page.submitRenewal"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import {
  bankRechargeApi,
  type BankRechargeRenewalWarnings
} from '@/v2/features/auto-recharge/public-api';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2RenewalOrderDrawer from './components/V2RenewalOrderDrawer.vue';
import V2RenewalWarningSettingsDialog from './components/V2RenewalWarningSettingsDialog.vue';
import V2RenewalsList from './components/V2RenewalsList.vue';
import V2RenewalsOverview from './components/V2RenewalsOverview.vue';
import V2RenewalsToolbar from './components/V2RenewalsToolbar.vue';
import { useRenewalsPage } from './useRenewalsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/renewals.css';
import '@/v2/features/auto-recharge/bank-recharge.css';

const page = reactive(useRenewalsPage());
const authStore = useAuthStore();
const isAdmin = computed(() => authStore.user?.roles?.includes('admin') ?? false);
const bankWarnings = useV2ModuleQuery<BankRechargeRenewalWarnings>({
  moduleKey: 'renewal-workbench',
  scope: 'renewal-warning-summary',
  key: 'bank-recharge-workbench',
  enabled: () => isAdmin.value,
  query: ({ signal }) => bankRechargeApi.renewalWarnings({ signal })
});
</script>
