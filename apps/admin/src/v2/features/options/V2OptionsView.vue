<template>
  <section class="v2-options-page">
    <V2AsyncRegion
      skeleton="settings"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.typesError"
      loading-title="正在加载选项类型"
      refreshing-title="正在更新选项类型"
      error-title="选项类型加载失败"
      @retry="page.loadInitialData"
    >
      <div class="v2-options-page__content">
        <V2OptionsOverview :page="page" />

        <div class="v2-options-workspace">
          <V2OptionsCategoryRail :page="page" />
          <div class="v2-options-content">
            <V2OptionsToolbar :page="page" />
            <V2OptionsList :page="page" />
          </div>
        </div>
      </div>
    </V2AsyncRegion>

    <V2OptionFormDrawer
      v-model="page.drawerVisible"
      v-model:type="page.form.type"
      v-model:name="page.form.name"
      v-model:parent-id="page.form.parentId"
      v-model:country-option-id="page.form.countryOptionId"
      v-model:business-amount="page.form.businessAmount"
      v-model:currency-code="page.form.currencyCode"
      v-model:fixed-fee="page.form.fixedFee"
      v-model:percentage-fee="page.form.percentageFee"
      v-model:sort-order="page.form.sortOrder"
      v-model:active="page.form.active"
      v-model:remark="page.form.remark"
      :editing-item="page.editingItem"
      :saving="page.saving"
      :submit-disabled-reason="page.submitDisabledReason"
      :type-definitions="page.typeDefinitions"
      :form-type-definition="page.formTypeDefinition"
      :parent-type-label="page.parentTypeLabel"
      :parent-options="page.parentOptions"
      :parent-options-loading="page.parentOptionsLoading"
      :country-options="page.countryOptions"
      :country-options-loading="page.countryOptionsLoading"
      :currency-options="page.currencyOptions"
      :selected-service-currency="page.selectedServiceCurrency"
      :selector-label="page.getSelectorLabel"
      @type-change="page.handleFormTypeChange"
      @confirm="page.submitForm"
    />

    <V2ConfirmDialog
      v-model="page.deleteDialogVisible"
      title="删除选项"
      :message="page.getDeleteMessage(page.deletingItem)"
      confirm-text="确认删除"
      danger
      :confirm-loading="page.deleting"
      @confirm="page.confirmDelete"
    />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2OptionFormDrawer from './components/V2OptionFormDrawer.vue';
import V2OptionsCategoryRail from './components/V2OptionsCategoryRail.vue';
import V2OptionsList from './components/V2OptionsList.vue';
import V2OptionsOverview from './components/V2OptionsOverview.vue';
import V2OptionsToolbar from './components/V2OptionsToolbar.vue';
import { useOptionsPage } from './useOptionsPage';
import '@/v2/styles/records.css';
import './options.css';

const page = reactive(useOptionsPage());
</script>
