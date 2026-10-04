<template>
  <section class="v2-page-layout recharge-page">
    <RechargePageContext
      :server-mode="operationMode === 'server_payment'"
      :direct-mode="operationMode === 'open_browser'"
      :connector-status="operationMode === 'server_payment' ? 'unknown' : connectorStatus"
      :connector-message="
        operationMode === 'server_payment' ? '服务器代理与执行器在提交时检查' : connectorMessage
      "
      @settings="openProxySettings"
      @history="historyOpen = true"
    />
    <V2AsyncRegion
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在读取自动充值资料"
      skeleton="form"
      @retry="refresh"
    >
      <div class="recharge-grid">
        <section class="recharge-panel recharge-entry-panel" aria-labelledby="recharge-form-title">
          <div class="recharge-section-heading">
            <h2 id="recharge-form-title">一键开通资料</h2>
            <span>{{ operationModeLabels[operationMode] }}</span>
          </div>
          <el-form
            name="chatgpt-auto-recharge"
            autocomplete="off"
            :model="details"
            :rules="rechargeRules"
            label-position="left"
            label-width="108px"
            require-asterisk-position="right"
            :disabled="formLocked"
          >
            <div class="recharge-mode-fields">
              <el-form-item label="操作模式" required>
                <el-radio-group v-model="operationMode">
                  <el-radio-button value="payment">本机充值</el-radio-button>
                  <el-radio-button value="server_payment">服务器充值</el-radio-button>
                  <el-radio-button value="open_browser">仅登录窗口</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="登录方式" required>
                <el-radio-group v-model="loginMethod">
                  <el-radio-button value="json">授权 JSON</el-radio-button>
                  <el-radio-button value="password">账号密码</el-radio-button>
                  <el-radio-button value="saved">已保存账号</el-radio-button>
                </el-radio-group>
              </el-form-item>
            </div>
            <div class="recharge-login-fields">
              <el-form-item
                v-if="loginMethod === 'json'"
                class="recharge-full-row"
                label="授权 JSON"
                required
                :error="jsonError"
              >
                <div class="recharge-json-row">
                  <el-input
                    type="password"
                    show-password
                    autocomplete="off"
                    :model-value="jsonInput"
                    :placeholder="
                      sessionJson
                        ? '授权已自动载入，可粘贴新 JSON 替换'
                        : '粘贴完整授权 JSON，将自动载入'
                    "
                    @update:model-value="updateJsonInput"
                  />
                  <label class="recharge-file-control" :class="{ 'is-disabled': formLocked }">
                    {{ importing ? '正在读取' : '导入文件' }}
                    <input
                      type="file"
                      accept="application/json,text/plain,.json,.txt"
                      :disabled="formLocked || importing"
                      @change="importJson"
                    />
                  </label>
                </div>
                <p v-if="sessionJson" class="recharge-field-success">
                  授权已自动载入{{
                    operationMode === 'payment' ? '，账单邮箱自动使用该账号邮箱' : ''
                  }}。
                </p>
              </el-form-item>
              <template v-else-if="loginMethod === 'saved'">
                <el-form-item class="recharge-full-row" label="ChatGPT 账号" required>
                  <el-select
                    v-model="selectedBankAccountId"
                    filterable
                    aria-label="选择已保存的 ChatGPT 账号"
                    placeholder="选择账号后自动读取登录资料"
                    :loading="bankAccountsQuery.phase.value === 'initial-loading'"
                  >
                    <el-option
                      v-for="item in savedBankAccounts"
                      :key="item.id"
                      :value="item.id"
                      :label="rechargeAccountOptionLabel(item)"
                      :disabled="!item.hasPassword"
                    />
                  </el-select>
                </el-form-item>
                <p v-if="bankAccountsQuery.error.value" class="recharge-error" role="alert">
                  {{ getApiErrorMessage(bankAccountsQuery.error.value) }}
                  <el-button link type="primary" @click="bankAccountsQuery.refresh">重试</el-button>
                </p>
                <p class="recharge-note">
                  {{
                    operationMode === 'server_payment'
                      ? '已保存 2FA 时在官网要求验证时自动取码；其他验证会停止并提示人工处理。'
                      : '2FA 已保存时官网要求验证会自动取码；未保存时在当前窗口手动完成。'
                  }}
                </p>
              </template>
              <template v-else>
                <RechargePasswordLoginFields
                  v-model:email="loginEmail"
                  v-model:password="loginPassword"
                  v-model:account-id="selectedBankAccountId"
                  v-model:login-method="loginMethod"
                  :accounts="savedBankAccounts"
                  :loading="bankAccountsQuery.phase.value === 'initial-loading'"
                  :disabled="formLocked"
                  :error="bankAccountsQuery.error.value"
                  @retry="bankAccountsQuery.refresh"
                />
                <RechargeTotpFields
                  v-model:source="totpSource"
                  v-model:secret-input="totpSecretInput"
                  v-model:saved-account-id="savedTotpAccountId"
                  :server-mode="operationMode === 'server_payment'"
                  :saved-accounts="savedTotpAccounts"
                  :secret-error="totpSecretError"
                  :loading="savedTotpQuery.phase.value === 'initial-loading'"
                  :error="
                    savedTotpQuery.error.value ? getApiErrorMessage(savedTotpQuery.error.value) : ''
                  "
                  @retry="savedTotpQuery.refresh"
                />
              </template>
            </div>
            <el-form-item v-if="operationMode === 'open_browser'" label="窗口名称" required>
              <el-input
                v-model="windowName"
                maxlength="80"
                placeholder="输入本次比特浏览器窗口名称"
              />
            </el-form-item>

            <div v-else class="recharge-fields recharge-options-grid">
              <el-form-item
                v-if="operationMode !== 'server_payment'"
                class="recharge-full-row"
                label="窗口名称"
                required
              >
                <el-input
                  v-model="windowName"
                  maxlength="80"
                  placeholder="输入本次比特浏览器窗口名称"
                />
              </el-form-item>
              <V2RechargePlanCurrencyFields
                v-model:plan="plan"
                v-model:currency="lockedCurrency"
                :currencies="availableCurrencyOptions"
                :error="
                  bankCurrenciesQuery.error.value
                    ? getApiErrorMessage(bankCurrenciesQuery.error.value)
                    : ''
                "
                @retry="bankCurrenciesQuery.refresh"
              />
              <V2RechargePaymentCapField
                v-if="operationMode === 'server_payment'"
                :plan="plan"
                :currency-code="lockedCurrency"
                :caps="paymentCapsQuery.data.value?.items ?? []"
                :phase="paymentCapsQuery.phase.value"
                :load-error="
                  paymentCapsQuery.error.value
                    ? getApiErrorMessage(paymentCapsQuery.error.value)
                    : ''
                "
                @refresh="paymentCapsQuery.refresh"
              />
              <el-form-item v-else label="最高付款" required>
                <el-input v-model="maxAmount" inputmode="decimal" maxlength="12">
                  <template #append>{{ lockedCurrency }}</template>
                </el-input>
              </el-form-item>
              <V2RechargeProxySelect
                v-if="
                  operationMode === 'server_payment' ||
                  availableProxyCountries.length ||
                  proxyCountriesQuery.error.value
                "
                v-model:country-code="selectedProxyCountryCode"
                v-model:proxy-id="selectedProxyId"
                :countries="availableProxyCountries"
                :login-country-restriction="loginCountryRestriction"
                :proxies="availableProxies"
                :default-proxy-id="
                  operationMode === 'server_payment' &&
                  serverProxySettings.settingsQuery.data.value?.proxy?.status === 'active'
                    ? serverProxySettings.settingsQuery.data.value.proxy.id
                    : ''
                "
                :loading="proxiesQuery.phase.value === 'initial-loading'"
                :error="
                  proxyCountriesQuery.error.value || proxiesQuery.error.value
                    ? getApiErrorMessage(
                        proxyCountriesQuery.error.value || proxiesQuery.error.value
                      )
                    : ''
                "
                @retry="
                  proxyCountriesQuery.refresh();
                  proxiesQuery.refresh();
                "
                @update:country-code="markProxySelectionManual"
                @update:proxy-id="markProxySelectionManual"
                @use-default="useServerDefaultProxy"
              />
            </div>

            <section
              v-if="operationMode !== 'open_browser'"
              class="recharge-billing"
              aria-labelledby="recharge-billing-title"
            >
              <div class="recharge-billing-heading">
                <h3 id="recharge-billing-title">银行卡与账单</h3>
                <el-form-item class="recharge-billing-email" label="账单邮箱">
                  <span class="recharge-account-email">
                    {{
                      details.email ||
                      (loginMethod === 'json'
                        ? '载入授权 JSON 后自动使用账号邮箱'
                        : '填写账号邮箱后自动使用')
                    }}
                  </span>
                </el-form-item>
              </div>
              <div class="recharge-billing-grid">
                <V2SavedPaymentCardField
                  class="recharge-saved-card"
                  :value="selectedPaymentCardId"
                  :cards="savedPaymentCards"
                  :loading="paymentCardsQuery.phase.value === 'initial-loading'"
                  :detail-loading="paymentCardLoading"
                  :error="paymentCardsQuery.error.value"
                  @select="selectSavedCard"
                  @retry="paymentCardsQuery.refresh"
                />
                <V2RechargePaymentFields v-model="details" :name-match="nameMatch" />
                <V2RechargeBillingAddressFields
                  v-model="details"
                  v-model:source="addressSource"
                  v-model:address-id="selectedAddressId"
                  :operation-mode="operationMode"
                  :addresses="availableAddresses"
                  :selected-address="selectedAddress"
                  :loading="
                    addressQuery.phase.value === 'initial-loading' ||
                    addressQuery.phase.value === 'refreshing'
                  "
                  :error="
                    addressQuery.error.value ? getApiErrorMessage(addressQuery.error.value) : ''
                  "
                  @retry="addressQuery.refresh"
                  @select="markAddressSelectionManual"
                />
              </div>
            </section>
            <RechargeSubmission
              v-model="authorizeSinglePayment"
              :operation-mode="operationMode"
              :can-start="canStart"
              :can-start-open="canStartOpen"
              :busy="busy"
              @start="start"
              @start-open="startOpen"
            />
          </el-form>
        </section>
        <section
          class="recharge-panel recharge-status-panel"
          aria-labelledby="recharge-result-title"
        >
          <div class="recharge-section-heading">
            <h2 id="recharge-result-title">执行状态</h2>
            <span>官网金额与结果实时回传</span>
          </div>
          <p class="recharge-workflow" role="status">{{ workflowMessage }}</p>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <RechargeResult :job="selected" :mode="operationMode" />
          <div class="recharge-actions">
            <p v-if="needsCode && !needsManualCode" class="recharge-note" role="status">
              {{ autoCodeMessage }}
            </p>
            <el-button
              v-if="needsCode && autoCodeFailureJobId === selected?.id && totpReady"
              :loading="autoCodeBusy"
              @click="retryAutomaticCode"
              >重试自动取码</el-button
            >
            <el-form
              v-if="needsManualCode"
              label-position="left"
              label-width="112px"
              require-asterisk-position="right"
              class="recharge-code-form"
              @submit.prevent="submitLoginCode"
            >
              <el-form-item label="一次性验证码" required>
                <el-input
                  v-model="loginCode"
                  type="password"
                  show-password
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="8"
                  placeholder="输入当前 6 至 8 位验证码"
                />
              </el-form-item>
              <el-button type="primary" :loading="busy" @click="submitLoginCode"
                >提交验证码</el-button
              >
            </el-form>
            <el-button v-if="needsHuman" type="primary" :loading="busy" @click="resume">
              {{ resumeActionLabel }}
            </el-button>
            <el-button v-if="canCancel" :disabled="busy" @click="cancel">停止本次任务</el-button>
            <el-button v-if="canRecheck" type="primary" :loading="busy" @click="recheck">
              只读复查原订单
            </el-button>
            <el-button
              v-if="canResolveNoBankRequest"
              type="warning"
              :loading="busy"
              @click="resolveNoBankRequest"
            >
              确认银行卡未收到付款请求
            </el-button>
            <el-button :disabled="busy || query.phase.value === 'refreshing'" @click="refresh">
              刷新原任务状态
            </el-button>
          </div>
        </section>
      </div>
    </V2AsyncRegion>
    <RechargeBrowserSettings
      v-if="settingsOpen && operationMode !== 'server_payment'"
      :settings="browserSettings"
    />
    <RechargeServerProxySettings
      v-if="serverProxySettings.open.value"
      :settings="serverProxySettings"
    />
    <RechargeHistoryDrawer
      v-if="historyOpen"
      v-model="historyOpen"
      :jobs="jobs"
      :can-recheck="canRecheck"
      :can-resolve-no-bank-request="canResolveNoBankRequest"
      :busy="busy"
      @select="selectJob"
      @recheck="recheck"
      @resolve-no-bank-request="resolveNoBankRequest"
    />
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import RechargeTotpFields from './RechargeTotpFields.vue';
import RechargePasswordLoginFields from './RechargePasswordLoginFields.vue';
import RechargeSubmission from './RechargeSubmission.vue';
import { rechargeRules } from './recharge-form';
import RechargePageContext from './RechargePageContext.vue';
import { useAutoRecharge } from './useAutoRecharge';
import { rechargeAccountOptionLabel } from './recharge-account-options';
import V2SavedPaymentCardField from './V2SavedPaymentCardField.vue';
import V2RechargePaymentFields from './V2RechargePaymentFields.vue';
import V2RechargeProxySelect from './V2RechargeProxySelect.vue';
import V2RechargePlanCurrencyFields from './V2RechargePlanCurrencyFields.vue';
import V2RechargeBillingAddressFields from './V2RechargeBillingAddressFields.vue';
import V2RechargePaymentCapField from './V2RechargePaymentCapField.vue';
const RechargeResult = defineAsyncComponent(() => import('./RechargeResult.vue'));
const RechargeBrowserSettings = defineAsyncComponent(() => import('./RechargeBrowserSettings.vue'));
const RechargeServerProxySettings = defineAsyncComponent(
  () => import('./RechargeServerProxySettings.vue')
);
const RechargeHistoryDrawer = defineAsyncComponent(() => import('./RechargeHistoryDrawer.vue'));
const historyOpen = ref(false);
const operationModeLabels = {
  server_payment: '单账户 · 服务器 · 单次付款',
  open_browser: '单账户 · 单窗口 · 免付款',
  payment: '单账户 · 单窗口 · 单次付款'
};
const {
  query,
  addressQuery,
  jobs,
  availableAddresses,
  selectedAddress,
  selectedAddressId,
  markAddressSelectionManual,
  addressSource,
  selected,
  jsonInput,
  sessionJson,
  jsonError,
  loginMethod,
  selectedBankAccountId,
  loginCountryRestriction,
  selectedPaymentCardId,
  savedBankAccounts,
  bankAccountsQuery,
  savedPaymentCards,
  paymentCardsQuery,
  paymentCardLoading,
  selectSavedCard,
  bankCurrenciesQuery,
  availableCurrencyOptions,
  paymentCapsQuery,
  loginEmail,
  loginPassword,
  loginCode,
  totpSource,
  totpSecretInput,
  savedTotpAccountId,
  savedTotpAccounts,
  savedTotpQuery,
  totpSecretError,
  totpReady,
  plan,
  windowName,
  lockedCurrency,
  selectedProxyCountryCode,
  selectedProxyId,
  availableProxyCountries,
  availableProxies,
  proxyCountriesQuery,
  proxiesQuery,
  maxAmount,
  authorizeSinglePayment,
  details,
  busy,
  error,
  importing,
  formLocked,
  nameMatch,
  operationMode,
  canStart,
  canStartOpen,
  canCancel,
  canRecheck,
  canResolveNoBankRequest,
  needsHuman,
  resumeActionLabel,
  needsCode,
  needsManualCode,
  autoCodeBusy,
  autoCodeFailureJobId,
  autoCodeMessage,
  workflowMessage,
  browserSettings,
  serverProxySettings,
  openProxySettings,
  useServerDefaultProxy,
  markProxySelectionManual,
  settingsOpen,
  connectorStatus,
  connectorMessage,
  updateJsonInput,
  importJson,
  start,
  startOpen,
  recheck,
  resolveNoBankRequest,
  selectJob,
  resume,
  submitLoginCode,
  retryAutomaticCode,
  cancel,
  refresh
} = useAutoRecharge();
</script>
<style scoped src="./auto-recharge.css"></style>
