<template>
  <section class="v2-order-entry-page">
    <V2AsyncRegion
      skeleton="form"
      :phase="optionsQueryPhase"
      :previous-data="optionsParameterTransition"
      :error="optionsError"
      loading-title="正在加载订单录入资料"
      refreshing-title="正在更新订单录入资料"
      error-title="订单录入资料加载失败"
      @retry="retryEntryOptions"
    >
      <V2OrderEntryPrerequisiteAlert
        :missing-options="missingOptionsConfiguration"
        :missing-customers="missingCustomersConfiguration"
        :message="emptyConfigurationMessage"
        :can-manage-options="canManageOptions"
        :can-create-customer="canCreateCustomer"
        :can-view-customers="canViewCustomers"
        @open-options="openRoute('/v2/options')"
        @quick-customer="quickCustomerVisible = true"
        @open-customers="openRoute('/v2/customers')"
      />

      <section class="v2-order-entry-workspace">
        <el-form
          ref="formRef"
          class="v2-horizontal-form v2-order-entry-form"
          :model="form"
          :rules="rules"
          label-position="left"
          label-width="112px"
          require-asterisk-position="right"
          status-icon
          scroll-to-error
          :scroll-into-view-options="{ block: 'center', behavior: 'smooth' }"
        >
          <V2SectionHeading
            class="v2-order-entry-section-header"
            title="订单资料"
            help="订单号由系统自动生成，提交前无需手工填写。"
          />

          <div class="v2-order-entry-groups">
            <section class="v2-order-entry-field-group">
              <V2SectionHeading
                as="div"
                level="h3"
                class="v2-order-entry-group-title"
                :step="1"
                compact
                title="业务与对象"
                help="先选择业务，系统会按国家、状态和余额自动匹配可用 ID。"
              />
              <div class="v2-order-entry-group-columns">
                <div class="v2-order-entry-form-column">
                  <el-form-item label="国家" prop="countryId">
                    <el-select
                      v-model="form.countryId"
                      filterable
                      placeholder="选择国家"
                      @change="handleCountryChange"
                    >
                      <el-option
                        v-for="country in entryOptions.countries"
                        :key="country.id"
                        :label="country.name"
                        :value="country.id"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item label="业务名称" prop="serviceOptionId">
                    <el-select
                      v-model="form.serviceOptionId"
                      filterable
                      :disabled="!form.categoryId"
                      placeholder="选择业务"
                    >
                      <el-option
                        v-for="service in availableServices"
                        :key="service.id"
                        :label="`${service.name} / ${formatDecimal(service.businessAmount)} ${service.currencyCode ?? ''}`"
                        :value="service.id"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item label="客户" prop="customerId">
                    <div class="v2-order-entry-customer-control">
                      <V2CustomerRemoteSelect
                        v-model="form.customerId"
                        :customers="customerOptions"
                        :keyword="customerKeyword"
                        :searching="customerSearching"
                        :remote-method="searchCustomers"
                      />
                      <AppButton
                        v-if="canCreateCustomer"
                        class="v2-order-entry-add-customer"
                        variant="ghost"
                        @click="quickCustomerVisible = true"
                      >
                        <el-icon><Plus /></el-icon>
                        新增客户
                      </AppButton>
                    </div>
                  </el-form-item>
                </div>

                <div class="v2-order-entry-form-column">
                  <el-form-item label="业务分类" prop="categoryId">
                    <el-select
                      v-model="form.categoryId"
                      filterable
                      :disabled="!form.countryId"
                      placeholder="选择分类"
                      @change="handleCategoryChange"
                    >
                      <el-option
                        v-for="category in availableCategories"
                        :key="category.id"
                        :label="category.name"
                        :value="category.id"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item label="使用 ID" prop="accountId">
                    <el-select
                      v-model="form.accountId"
                      filterable
                      :remote="idSelectionMode === 'manual'"
                      :reserve-keyword="idSelectionMode === 'manual'"
                      :remote-method="searchManualCandidates"
                      :loading="matchingLoading"
                      :disabled="!canMatch"
                      :placeholder="
                        idSelectionMode === 'manual' ? '输入 Apple ID 搜索' : '等待自动匹配'
                      "
                    >
                      <el-option
                        v-for="candidate in candidateItems"
                        :key="candidate.id"
                        :label="`${candidate.appleIdMasked} / 余额 ${formatDecimal(candidate.currentBalance)}`"
                        :value="candidate.id"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item label="ID 选择方式">
                    <el-radio-group
                      v-model="idSelectionMode"
                      class="v2-order-entry-selection-mode"
                      @change="handleIdSelectionModeChange"
                    >
                      <el-radio value="auto">自动匹配</el-radio>
                      <el-radio value="manual">手动选择</el-radio>
                    </el-radio-group>
                  </el-form-item>
                </div>
              </div>
            </section>

            <section class="v2-order-entry-field-group">
              <V2SectionHeading
                as="div"
                level="h3"
                class="v2-order-entry-group-title"
                :step="2"
                compact
                title="客户与结算"
                help="补充结算资料、售卖价格与目标定价信息。"
              />
              <div class="v2-order-entry-group-columns">
                <div class="v2-order-entry-form-column">
                  <el-form-item label="结算平台" prop="settlementPlatformOptionId">
                    <el-select
                      v-model="form.settlementPlatformOptionId"
                      filterable
                      placeholder="请选择收款方式"
                      @change="handleSettlementPlatformChange"
                    >
                      <el-option
                        v-for="platform in entryOptions.settlementPlatforms"
                        :key="platform.id"
                        :label="platform.name"
                        :value="platform.id"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item label="平台订单号" prop="platformOrderNo">
                    <el-input
                      v-model="form.platformOrderNo"
                      maxlength="160"
                      :disabled="!form.settlementPlatformOptionId"
                      placeholder="选填"
                    />
                  </el-form-item>

                  <el-form-item label="客户业务账号">
                    <el-input
                      v-model="form.websiteAccount"
                      maxlength="255"
                      autocomplete="off"
                      placeholder="选填"
                    />
                  </el-form-item>

                  <V2OrderProfitRateField
                    v-model="profitRateInputValue"
                    label="目标/反算利率"
                    receipt-placeholder="填写售卖价格后自动反算"
                    :mode="pricingInputMode"
                    :hint="profitRateInputHint"
                  />
                </div>

                <div class="v2-order-entry-form-column">
                  <V2OrderReceiptFields
                    :form="form"
                    :received-amount-preview="receivedAmountPreview"
                    :receipt-fx-quote="receiptFxQuote"
                    :receipt-fx-loading="receiptFxLoading"
                    :receipt-fx-error="receiptFxError"
                    :format-decimal="formatDecimal"
                    @currency-change="handleReceivedCurrencyChange"
                    @fx-mode-change="handleFxModeChange"
                    @price-input="handleManualPriceInput"
                    @manual-rate-input="handleManualFxRateInput"
                    @retry-fx-quote="loadReceiptFxQuote"
                  />
                  <V2OrderPricingFields
                    :form="form"
                    :suggested-receipt="suggestedReceipt"
                    :recommendation-applied="recommendationApplied"
                    :applied-suggested-original="appliedSuggestedOriginal"
                    :pricing-input-mode="pricingInputMode"
                    :format-decimal="formatDecimal"
                    @apply-suggested="applySuggestedReceivedAmount"
                    @undo-suggested="undoSuggestedReceivedAmount"
                  />
                </div>
              </div>
            </section>

            <section class="v2-order-entry-field-group">
              <V2SectionHeading
                as="div"
                level="h3"
                class="v2-order-entry-group-title"
                :step="3"
                compact
                title="周期与备注"
                help="核对使用周期、成本和备注后再提交。"
              />
              <div class="v2-order-entry-group-columns v2-order-entry-period-columns">
                <div class="v2-order-entry-form-column">
                  <el-form-item
                    :label="
                      selectedService?.currencyCode
                        ? `消耗余额（${selectedService.currencyCode}）`
                        : '消耗余额'
                    "
                    prop="balanceAmount"
                  >
                    <el-input
                      v-model="form.balanceAmount"
                      inputmode="decimal"
                      maxlength="19"
                      placeholder="例如 20"
                    />
                  </el-form-item>

                  <el-form-item label="开通时间" prop="openedAt">
                    <el-date-picker
                      v-model="form.openedAt"
                      type="datetime"
                      placeholder="选择开通时间"
                      format="YYYY-MM-DD HH:mm"
                      @change="handleOpenedAtChange"
                    />
                  </el-form-item>

                  <el-form-item label="到期时间" prop="dueAt">
                    <el-date-picker
                      v-model="form.dueAt"
                      type="datetime"
                      placeholder="选择到期时间"
                      format="YYYY-MM-DD HH:mm"
                    />
                  </el-form-item>
                </div>

                <div class="v2-order-entry-form-column">
                  <el-form-item label="ID 购买成本">
                    <div class="v2-order-entry-readonly v2-order-entry-cost-check">
                      <strong>¥{{ formatDecimal(appliedAccountCostPreview) }}</strong>
                      <span v-if="form.accountDisposition === 'sold'">
                        本单计入 ID 成本快照 ¥{{ formatDecimal(accountPurchaseCostPreview) }}
                      </span>
                      <span v-else>
                        保留 ID 时本单不计入，当前快照 ¥{{
                          formatDecimal(accountPurchaseCostPreview)
                        }}
                      </span>
                    </div>
                  </el-form-item>

                  <el-form-item label="平台手续费">
                    <div class="v2-order-entry-readonly">
                      <strong>¥{{ formatDecimal(platformFeePreview) }}</strong>
                      <el-tag type="info" effect="plain">服务端复核</el-tag>
                    </div>
                  </el-form-item>

                  <el-form-item label="备注" class="v2-order-entry-remark-item">
                    <el-input
                      v-model="form.remark"
                      type="textarea"
                      :autosize="{ minRows: 1, maxRows: 3 }"
                      maxlength="2000"
                      show-word-limit
                      placeholder="选填"
                    />
                  </el-form-item>
                </div>
              </div>
            </section>
          </div>
        </el-form>

        <V2OrderEntryCandidates
          v-model:account-id="form.accountId"
          v-model:account-disposition="form.accountDisposition"
          :id-selection-mode="idSelectionMode"
          :can-match="canMatch"
          :matching-loading="matchingLoading"
          :matching-phase="matchingPhase"
          :matching-parameter-transition="matchingParameterTransition"
          :matching-result="matchingResult"
          :candidate-items="candidateItems"
          :matching-error="matchingError"
          :matching-empty-message="matchingEmptyMessage"
          :format-decimal="formatDecimal"
          @retry="loadCandidates"
        />

        <V2OrderEntryLiveSummary
          :selected-candidate="selectedCandidate"
          :selected-country-name="selectedCountry?.name ?? ''"
          :account-purchase-cost-preview="appliedAccountCostPreview"
          :platform-fee-preview="platformFeePreview"
          :estimated-balance-cost-preview="estimatedBalanceCostPreview"
          :total-cost-preview="totalCostPreview"
          :estimated-profit-preview="estimatedProfitPreview"
          :estimated-profit-rate-preview="estimatedProfitRatePreview"
          :format-decimal="formatDecimal"
        />

        <V2OrderEntrySubmitBar
          :submitting="submitting"
          :disabled-reason="submitDisabledReason"
          :selected-id="selectedCandidate?.appleIdMasked ?? ''"
          :selected-balance="selectedCandidate?.currentBalance ?? '0'"
          :selected-currency="selectedCountry?.currencyCode ?? ''"
          :estimated-profit="estimatedProfitPreview"
          :estimated-profit-rate="estimatedProfitRatePreview"
          :format-decimal="formatDecimal"
          @submit="submitOrder"
        />
      </section>

      <el-alert
        v-if="consumptionError"
        type="error"
        title="订单已创建，但余额尚未扣减"
        :description="consumptionError"
        show-icon
        :closable="false"
      />
      <div class="v2-order-entry-result-shell">
        <V2OrderEntryResult
          :created-result="createdResult"
          :consumption-result="consumptionResult"
          :has-pending-consumption="hasPendingConsumption"
          :consuming="consuming"
          :format-decimal="formatDecimal"
          @retry="retryConsumption"
          @view-orders="openRoute('/v2/orders')"
        />
      </div>

      <V2QuickCustomerDrawer v-model="quickCustomerVisible" @created="handleCustomerCreated" />
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { navigateSafely } from '@/v2/router/navigateSafely';
import V2OrderEntryCandidates from './components/V2OrderEntryCandidates.vue';
import V2OrderEntryLiveSummary from './components/V2OrderEntryLiveSummary.vue';
import V2OrderEntryPrerequisiteAlert from './components/V2OrderEntryPrerequisiteAlert.vue';
import V2OrderEntrySubmitBar from './components/V2OrderEntrySubmitBar.vue';
import V2OrderPricingFields from './components/V2OrderPricingFields.vue';
import V2OrderProfitRateField from './components/V2OrderProfitRateField.vue';
import V2OrderReceiptFields from './components/V2OrderReceiptFields.vue';
import V2OrderEntryResult from './components/V2OrderEntryResult.vue';
import V2CustomerRemoteSelect from './components/V2CustomerRemoteSelect.vue';
import V2QuickCustomerDrawer from './components/V2QuickCustomerDrawer.vue';
import { useOrderEntryPage } from './useOrderEntryPage';
import '@/v2/styles/order-entry.css';
const {
  router,
  formRef,
  optionsQueryPhase,
  optionsParameterTransition,
  optionsError,
  idSelectionMode,
  matchingLoading,
  matchingPhase,
  matchingParameterTransition,
  matchingError,
  matchingResult,
  submitting,
  consuming,
  createdResult,
  consumptionResult,
  consumptionError,
  entryOptions,
  customerOptions,
  customerKeyword,
  customerSearching,
  form,
  selectedCountry,
  availableCategories,
  availableServices,
  selectedService,
  candidateItems,
  selectedCandidate,
  missingOptionsConfiguration,
  missingCustomersConfiguration,
  canManageOptions,
  canViewCustomers,
  canCreateCustomer,
  canMatch,
  submitDisabledReason,
  hasPendingConsumption,
  platformFeePreview,
  receivedAmountPreview,
  accountPurchaseCostPreview,
  appliedAccountCostPreview,
  estimatedBalanceCostPreview,
  totalCostPreview,
  estimatedProfitPreview,
  estimatedProfitRatePreview,
  pricingInputMode,
  profitRateInputValue,
  profitRateInputHint,
  suggestedReceipt,
  recommendationApplied,
  appliedSuggestedOriginal,
  receiptFxQuote,
  receiptFxLoading,
  receiptFxError,
  matchingEmptyMessage,
  emptyConfigurationMessage,
  rules,
  handleOpenedAtChange,
  retryEntryOptions,
  searchCustomers,
  handleCountryChange,
  handleCategoryChange,
  handleSettlementPlatformChange,
  handleReceivedCurrencyChange,
  handleFxModeChange,
  handleIdSelectionModeChange,
  searchManualCandidates,
  loadCandidates,
  applySuggestedReceivedAmount,
  undoSuggestedReceivedAmount,
  handleManualPriceInput,
  handleManualFxRateInput,
  loadReceiptFxQuote,
  submitOrder,
  retryConsumption,
  handleCustomerCreated,
  formatDecimal
} = useOrderEntryPage();
const quickCustomerVisible = ref(false);
function openRoute(path: string) {
  void navigateSafely(router, path);
}
</script>
