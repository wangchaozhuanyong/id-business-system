<template>
  <section class="recharge-page">
    <RechargePageContext
      :server-mode="operationMode === 'server_payment'"
      :connector-status="operationMode === 'server_payment' ? 'unknown' : connectorStatus"
      :connector-message="
        operationMode === 'server_payment' ? '服务器代理与执行器在提交时检查' : connectorMessage
      "
      @settings="setSettingsOpen(true)"
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
        <section class="recharge-panel" aria-labelledby="recharge-form-title">
          <div class="recharge-section-heading">
            <div>
              <h2 id="recharge-form-title">一键开通资料</h2>
              <p class="recharge-note">官网地址固定为 ChatGPT；服务器任务使用独立浏览器环境。</p>
            </div>
            <span>{{
              operationMode === 'server_payment'
                ? '单账户 · 服务器 · 单次付款'
                : operationMode === 'open_browser'
                  ? '单账户 · 单窗口 · 免付款'
                  : '单账户 · 单窗口 · 单次付款'
            }}</span>
          </div>
          <el-form
            :model="details"
            :rules="rechargeRules"
            label-position="left"
            label-width="112px"
            require-asterisk-position="right"
            :disabled="formLocked"
          >
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
            <el-form-item
              v-if="loginMethod === 'json'"
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
              <el-form-item label="ChatGPT 账号" required>
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
                    :label="`${item.emailMasked}${item.hasPassword ? '' : ' · 未保存密码'}`"
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
              <el-form-item label="ChatGPT 账号" required>
                <el-input
                  v-model="loginEmail"
                  type="email"
                  autocomplete="off"
                  maxlength="250"
                  placeholder="输入账号邮箱"
                />
              </el-form-item>
              <el-form-item label="登录密码" required>
                <el-input
                  v-model="loginPassword"
                  type="password"
                  show-password
                  autocomplete="off"
                  maxlength="1024"
                  placeholder="仅用于本次官网登录"
                />
              </el-form-item>
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
            <el-form-item v-if="operationMode === 'open_browser'" label="窗口名称" required>
              <el-input
                v-model="windowName"
                maxlength="80"
                placeholder="输入本次比特浏览器窗口名称"
              />
            </el-form-item>

            <div v-else class="recharge-fields">
              <el-form-item v-if="operationMode !== 'server_payment'" label="窗口名称" required>
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
              <V2RechargeProxySelect
                v-if="availableProxyCountries.length || proxyCountriesQuery.error.value"
                v-model:country-code="selectedProxyCountryCode"
                v-model:proxy-id="selectedProxyId"
                :countries="availableProxyCountries"
                :login-country-restriction="loginCountryRestriction"
                :proxies="availableProxies"
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
            </div>

            <fieldset v-if="operationMode !== 'open_browser'" class="recharge-billing">
              <legend>银行卡与账单</legend>
              <V2SavedPaymentCardField
                :value="selectedPaymentCardId"
                :cards="savedPaymentCards"
                :loading="paymentCardsQuery.phase.value === 'initial-loading'"
                :error="paymentCardsQuery.error.value"
                @select="selectSavedCard"
                @retry="paymentCardsQuery.refresh"
              />
              <V2RechargePaymentFields v-model="details" />

              <el-form-item label="账单邮箱">
                <span class="recharge-account-email">
                  {{
                    details.email ||
                    (loginMethod === 'json'
                      ? '载入授权 JSON 后自动使用账号邮箱'
                      : '填写账号邮箱后自动使用')
                  }}
                </span>
              </el-form-item>

              <V2RechargeBillingAddressFields
                v-model="details"
                v-model:source="addressSource"
                v-model:address-id="selectedAddressId"
                :operation-mode="operationMode"
                :addresses="availableAddresses"
                :loading="
                  addressQuery.phase.value === 'initial-loading' ||
                  addressQuery.phase.value === 'refreshing'
                "
                :error="
                  addressQuery.error.value ? getApiErrorMessage(addressQuery.error.value) : ''
                "
                @retry="addressQuery.refresh"
              />
              <dl v-if="selectedAddress" class="recharge-fixed-address">
                <div>
                  <dt>国家</dt>
                  <dd>{{ selectedAddress.country }}</dd>
                </div>
                <div>
                  <dt>街道</dt>
                  <dd>{{ selectedAddress.line1 }}</dd>
                </div>
                <div>
                  <dt>城市</dt>
                  <dd>{{ selectedAddress.city }}</dd>
                </div>
                <div>
                  <dt>州与邮编</dt>
                  <dd>{{ selectedAddress.state }} {{ selectedAddress.postalCode }}</dd>
                </div>
              </dl>
            </fieldset>
            <div v-if="operationMode !== 'open_browser'" class="recharge-authorization">
              <el-checkbox v-model="authorizeSinglePayment">
                我已核对银行卡真实姓名、账单地址和币种，授权本任务在付款安全上限内最多提交一次官网付款
              </el-checkbox>
              <p class="recharge-note">
                官网币种不一致、今日应付超过上限、税费或订单金额不明确时立即停止；不会换币种或重试付款。
              </p>
            </div>
            <div class="recharge-form-footer">
              <el-button
                v-if="operationMode === 'open_browser'"
                type="primary"
                :disabled="!canStartOpen"
                :loading="busy"
                @click="startOpen"
              >
                打开比特浏览器并登录
              </el-button>
              <el-button v-else type="primary" :disabled="!canStart" :loading="busy" @click="start">
                {{
                  operationMode === 'server_payment'
                    ? '在服务器执行本次充值'
                    : '连接比特浏览器并执行本次充值'
                }}
              </el-button>
              <p class="recharge-note">
                {{
                  operationMode === 'server_payment'
                    ? '本次安全码仅传至服务器执行器内存；已保存的卡号加密存储，取用留审计。'
                    : operationMode === 'open_browser'
                      ? '登录资料只发送到本机连接器内存；登录成功后保留比特浏览器窗口供手动操作。'
                      : '本次安全码只发送到本机连接器内存；已保存的卡号加密存储，取用留审计。'
                }}
              </p>
            </div>
          </el-form>
        </section>
        <section class="recharge-panel" aria-labelledby="recharge-result-title">
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
              我已完成验证，继续原任务
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
      v-if="settingsOpen"
      :settings="browserSettings"
      :server-mode="operationMode === 'server_payment'"
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
import { rechargeRules } from './recharge-form';
import RechargePageContext from './RechargePageContext.vue';
import { useAutoRecharge } from './useAutoRecharge';
import V2SavedPaymentCardField from './V2SavedPaymentCardField.vue';
import V2RechargePaymentFields from './V2RechargePaymentFields.vue';
import V2RechargeProxySelect from './V2RechargeProxySelect.vue';
import V2RechargePlanCurrencyFields from './V2RechargePlanCurrencyFields.vue';
import V2RechargeBillingAddressFields from './V2RechargeBillingAddressFields.vue';
import V2RechargePaymentCapField from './V2RechargePaymentCapField.vue';
const RechargeResult = defineAsyncComponent(() => import('./RechargeResult.vue'));
const RechargeBrowserSettings = defineAsyncComponent(() => import('./RechargeBrowserSettings.vue'));
const RechargeHistoryDrawer = defineAsyncComponent(() => import('./RechargeHistoryDrawer.vue'));
const historyOpen = ref(false);
const {
  query,
  addressQuery,
  jobs,
  availableAddresses,
  selectedAddress,
  selectedAddressId,
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
  operationMode,
  canStart,
  canStartOpen,
  canCancel,
  canRecheck,
  canResolveNoBankRequest,
  needsHuman,
  needsCode,
  needsManualCode,
  autoCodeBusy,
  autoCodeFailureJobId,
  autoCodeMessage,
  workflowMessage,
  browserSettings,
  settingsOpen,
  setSettingsOpen,
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
