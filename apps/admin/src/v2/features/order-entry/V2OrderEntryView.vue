<template>
  <section class="v2-order-entry-page">
    <V2AsyncRegion
      skeleton="form"
      :loading="optionsLoading || isInitialLoading"
      :resolved="optionsResolved"
      :error="optionsError"
      loading-title="正在加载订单录入资料"
      refreshing-title="正在更新订单录入资料"
      error-title="订单录入资料加载失败"
      @retry="loadEntryOptions()"
    >
      <el-alert
        v-if="missingOptionsConfiguration || missingCustomersConfiguration"
        class="v2-order-entry-prerequisite-alert"
        type="warning"
        :title="emptyConfigurationMessage"
        show-icon
        :closable="false"
      >
        <div class="v2-order-entry-prerequisite-actions">
          <span>请先补全缺失资料，再继续创建订单。</span>
          <div>
            <AppButton
              v-if="missingOptionsConfiguration && canManageOptions"
              variant="ghost"
              @click="router.push('/v2/options')"
            >
              前往选项设置
            </AppButton>
            <AppButton
              v-if="missingCustomersConfiguration && canCreateCustomer"
              variant="ghost"
              @click="quickCustomerVisible = true"
            >
              快速新增客户
            </AppButton>
            <AppButton
              v-if="missingCustomersConfiguration && canViewCustomers"
              variant="ghost"
              @click="router.push('/v2/customers')"
            >
              前往客户管理
            </AppButton>
          </div>
        </div>
      </el-alert>

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

          <div class="v2-order-entry-grid">
            <V2SectionHeading
              as="div"
              level="h3"
              class="v2-order-entry-group-title"
              :step="1"
              compact
              title="业务与对象"
              help="先选择业务，系统会按国家、状态和余额自动匹配可用 ID。"
            />
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

            <el-form-item label="客户" prop="customerId" class="v2-order-entry-customer-item">
              <div class="v2-order-entry-customer-control">
                <el-select
                  v-model="form.customerId"
                  filterable
                  remote
                  reserve-keyword
                  :remote-method="searchCustomers"
                  :loading="customerSearching"
                  placeholder="搜索并选择客户"
                >
                  <el-option
                    v-for="customer in entryOptions.customers"
                    :key="customer.id"
                    :label="customerLabel(customer)"
                    :value="customer.id"
                  />
                </el-select>
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

            <el-form-item label="使用 ID" prop="accountId">
              <el-select
                v-model="form.accountId"
                filterable
                :remote="idSelectionMode === 'manual'"
                :reserve-keyword="idSelectionMode === 'manual'"
                :remote-method="searchManualCandidates"
                :loading="matchingLoading"
                :disabled="!canMatch"
                :placeholder="idSelectionMode === 'manual' ? '输入 Apple ID 搜索' : '等待自动匹配'"
              >
                <el-option
                  v-for="candidate in candidateItems"
                  :key="candidate.id"
                  :label="`${candidate.appleIdMasked} / 余额 ${formatDecimal(candidate.currentBalance)}`"
                  :value="candidate.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="ID 购买成本">
              <div class="v2-order-entry-readonly">
                <strong>¥{{ formatDecimal(accountPurchaseCostPreview) }}</strong>
                <span>{{ selectedCandidate ? '成本快照预览' : '选择 ID 后显示' }}</span>
              </div>
            </el-form-item>

            <V2SectionHeading
              as="div"
              level="h3"
              class="v2-order-entry-group-title"
              :step="2"
              compact
              title="客户与结算"
              help="补充客户账号、收款平台与本次实收金额。"
            />
            <el-form-item label="客户网站账号">
              <el-input
                v-model="form.websiteAccount"
                maxlength="255"
                autocomplete="off"
                placeholder="选填"
              />
            </el-form-item>

            <el-form-item label="ID 处理方式">
              <div class="v2-order-entry-disposition">
                <el-radio-group v-model="form.accountDisposition">
                  <el-radio value="retained">保留 ID</el-radio>
                  <el-radio value="sold">卖出 ID</el-radio>
                </el-radio-group>
                <small v-if="form.accountDisposition === 'sold'">
                  本单计入 ID 购买成本；创建后该 ID 将停止匹配、加卡和续费。
                </small>
                <small v-else>本单不计 ID 购买成本，ID 后续仍可继续使用。</small>
              </div>
            </el-form-item>

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
            <V2OrderReceiptFields
              :form="form"
              :received-amount-preview="receivedAmountPreview"
              :format-decimal="formatDecimal"
              @currency-change="handleReceivedCurrencyChange"
              @price-input="handleManualPriceInput"
            />
            <V2OrderPricingFields
              :form="form"
              :suggested-received="suggestedReceived"
              :recommendation-applied="recommendationApplied"
              :applied-suggested-cny="appliedSuggestedCny"
              :platform-fee-preview="platformFeePreview"
              :estimated-profit-preview="estimatedProfitPreview"
              :estimated-profit-rate-preview="estimatedProfitRatePreview"
              :format-decimal="formatDecimal"
              @apply-suggested="applySuggestedReceivedAmount"
              @undo-suggested="undoSuggestedReceivedAmount"
            />

            <V2SectionHeading
              as="div"
              level="h3"
              class="v2-order-entry-group-title"
              :step="3"
              compact
              title="周期与备注"
              help="核对开通周期后再提交，创建成功会返回账务回执。"
            />
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

            <el-form-item label="备注" class="v2-order-entry-wide">
              <el-input
                v-model="form.remark"
                type="textarea"
                :rows="3"
                maxlength="2000"
                show-word-limit
                placeholder="选填"
              />
            </el-form-item>
          </div>

          <footer class="v2-order-entry-actions">
            <div>
              <span>订单状态</span>
              <strong>待处理</strong>
            </div>
            <span v-if="submitDisabledReason" class="v2-submit-disabled-reason" role="status">
              {{ submitDisabledReason }}
            </span>
            <AppButton
              variant="primary"
              :loading="submitting"
              :disabled="Boolean(submitDisabledReason)"
              :aria-label="
                submitDisabledReason ? `创建并扣减余额：${submitDisabledReason}` : '创建并扣减余额'
              "
              @click="submitOrder"
            >
              <el-icon><CircleCheck /></el-icon>
              创建并扣减余额
            </AppButton>
          </footer>
        </el-form>

        <V2OrderEntryCandidates
          v-model:account-id="form.accountId"
          :id-selection-mode="idSelectionMode"
          :selected-candidate="selectedCandidate"
          :selected-country-name="selectedCountry?.name ?? ''"
          :account-disposition="form.accountDisposition"
          :account-purchase-cost-preview="accountPurchaseCostPreview"
          :applied-account-cost-preview="appliedAccountCostPreview"
          :estimated-balance-cost-preview="estimatedBalanceCostPreview"
          :total-cost-preview="totalCostPreview"
          :platform-fee-preview="platformFeePreview"
          :estimated-profit-preview="estimatedProfitPreview"
          :can-match="canMatch"
          :matching-loading="matchingLoading"
          :matching-result="matchingResult"
          :candidate-items="candidateItems"
          :matching-error="matchingError"
          :matching-empty-message="matchingEmptyMessage"
          :format-decimal="formatDecimal"
          @retry="loadCandidates"
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

      <V2OrderEntryResult
        :created-result="createdResult"
        :consumption-result="consumptionResult"
        :has-pending-consumption="hasPendingConsumption"
        :consuming="consuming"
        :format-decimal="formatDecimal"
        @retry="retryConsumption"
        @view-orders="router.push('/v2/orders')"
      />

      <V2QuickCustomerDrawer v-model="quickCustomerVisible" @created="handleCustomerCreated" />
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { CircleCheck, Plus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2OrderEntryCandidates from './components/V2OrderEntryCandidates.vue';
import V2OrderPricingFields from './components/V2OrderPricingFields.vue';
import V2OrderReceiptFields from './components/V2OrderReceiptFields.vue';
import V2OrderEntryResult from './components/V2OrderEntryResult.vue';
import V2QuickCustomerDrawer from './components/V2QuickCustomerDrawer.vue';
import { useOrderEntryPage } from './useOrderEntryPage';
import '@/v2/styles/order-entry.css';

const {
  router,
  formRef,
  optionsLoading,
  optionsError,
  optionsResolved,
  customerSearching,
  idSelectionMode,
  matchingLoading,
  matchingError,
  matchingResult,
  submitting,
  consuming,
  createdResult,
  consumptionResult,
  consumptionError,
  entryOptions,
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
  suggestedReceived,
  recommendationApplied,
  appliedSuggestedCny,
  matchingEmptyMessage,
  emptyConfigurationMessage,
  rules,
  isInitialLoading,
  handleOpenedAtChange,
  loadEntryOptions,
  searchCustomers,
  handleCountryChange,
  handleCategoryChange,
  handleSettlementPlatformChange,
  handleReceivedCurrencyChange,
  handleIdSelectionModeChange,
  searchManualCandidates,
  loadCandidates,
  applySuggestedReceivedAmount,
  undoSuggestedReceivedAmount,
  handleManualPriceInput,
  submitOrder,
  retryConsumption,
  handleCustomerCreated,
  customerLabel,
  formatDecimal
} = useOrderEntryPage();
const quickCustomerVisible = ref(false);
</script>
