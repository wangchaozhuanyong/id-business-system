<template>
  <section class="v2-records-page">
    <V2RenewalsOverview :page="page" />
    <V2RenewalsToolbar :page="page" />
    <V2RenewalsList :page="page" />

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
import { reactive } from 'vue';
import V2RenewalOrderDrawer from './components/V2RenewalOrderDrawer.vue';
import V2RenewalWarningSettingsDialog from './components/V2RenewalWarningSettingsDialog.vue';
import V2RenewalsList from './components/V2RenewalsList.vue';
import V2RenewalsOverview from './components/V2RenewalsOverview.vue';
import V2RenewalsToolbar from './components/V2RenewalsToolbar.vue';
import { useRenewalsPage } from './useRenewalsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/renewals.css';

const page = reactive(useRenewalsPage());
</script>
