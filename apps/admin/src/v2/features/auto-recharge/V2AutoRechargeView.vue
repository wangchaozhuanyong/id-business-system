<template>
  <section class="recharge-page">
    <V2PageContext
      description="使用授权 JSON 或账号密码登录本机比特浏览器；自动充值按金额上限执行，需要真人或银行验证时保留原窗口等待处理。"
    >
      <template #status>
        <span class="recharge-connector-status" :data-status="connectorStatus">
          {{ connectorMessage }}
        </span>
      </template>
      <template #actions>
        <el-button @click="setSettingsOpen(true)">代理 IP 与窗口设置</el-button>
        <el-button @click="historyOpen = true">最近执行记录</el-button>
      </template>
    </V2PageContext>
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
              <p class="recharge-note">官网地址固定为 ChatGPT；不需要填写登录网址。</p>
            </div>
            <span>{{
              operationMode === 'open_browser'
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
                <el-radio-button value="payment">自动充值</el-radio-button>
                <el-radio-button value="open_browser">仅登录窗口</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="登录方式" required>
              <el-radio-group v-model="loginMethod">
                <el-radio-button value="json">授权 JSON</el-radio-button>
                <el-radio-button value="password">账号密码</el-radio-button>
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
              <el-form-item label="窗口名称" required>
                <el-input
                  v-model="windowName"
                  maxlength="80"
                  placeholder="输入本次比特浏览器窗口名称"
                />
              </el-form-item>
              <el-form-item label="开通套餐" required>
                <el-select v-model="plan" aria-label="选择开通套餐">
                  <el-option
                    v-for="item in V2_RECHARGE_PLANS"
                    :key="item"
                    :label="planLabels[item]"
                    :value="item"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="锁定币种" required>
                <el-select v-model="lockedCurrency" aria-label="选择锁定币种" filterable>
                  <el-option
                    v-for="currency in currencyOptions"
                    :key="currency.value"
                    :label="currency.label"
                    :value="currency.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="最高付款" required>
                <el-input v-model="maxAmount" inputmode="decimal" maxlength="12">
                  <template #append>{{ lockedCurrency }}</template>
                </el-input>
              </el-form-item>
            </div>

            <fieldset v-if="operationMode === 'payment'" class="recharge-billing">
              <legend>银行卡与账单</legend>
              <div class="recharge-fields">
                <el-form-item
                  v-for="field in paymentFields"
                  :key="field.key"
                  :label="field.label"
                  :prop="field.key"
                  :required="field.required"
                >
                  <el-input
                    v-if="field.key === 'expiry'"
                    :model-value="details.expiry"
                    :placeholder="field.placeholder"
                    inputmode="numeric"
                    autocomplete="off"
                    @update:model-value="details.expiry = formatRechargeExpiry(String($event))"
                  />
                  <el-input
                    v-else
                    v-model="details[field.key]"
                    :type="field.secret ? 'password' : 'text'"
                    :show-password="field.secret"
                    :maxlength="field.max"
                    :placeholder="field.placeholder"
                    autocomplete="off"
                  />
                </el-form-item>
              </div>

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

              <el-form-item label="地址库" required>
                <el-select
                  v-model="selectedAddressId"
                  aria-label="选择未使用账单地址"
                  filterable
                  :loading="
                    addressQuery.phase.value === 'initial-loading' ||
                    addressQuery.phase.value === 'refreshing'
                  "
                  placeholder="选择一条未使用地址"
                  no-data-text="没有未使用地址"
                >
                  <el-option
                    v-for="address in availableAddresses"
                    :key="address.id"
                    :label="address.line1"
                    :value="address.id"
                  />
                </el-select>
              </el-form-item>
              <p v-if="addressQuery.error.value" class="recharge-error" role="alert">
                {{ getApiErrorMessage(addressQuery.error.value) }}
                <el-button link type="primary" @click="addressQuery.refresh">重试</el-button>
              </p>
              <p v-else-if="!availableAddresses.length" class="recharge-note" role="status">
                暂无未使用地址，请先到“地址管理”导入或启用地址。
              </p>
              <dl v-if="selectedAddress" class="recharge-fixed-address">
                <div>
                  <dt>国家</dt>
                  <dd>美国</dd>
                </div>
                <div>
                  <dt>街道</dt>
                  <dd>{{ selectedAddress.line1 }}</dd>
                </div>
                <div>
                  <dt>城市</dt>
                  <dd>波特兰</dd>
                </div>
                <div>
                  <dt>州与邮编</dt>
                  <dd>俄勒冈州 97204</dd>
                </div>
              </dl>
            </fieldset>

            <div v-if="operationMode === 'payment'" class="recharge-authorization">
              <el-checkbox v-model="authorizeSinglePayment">
                我已核对锁定币种和最高付款金额，授权本任务最多提交一次官网付款
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
                连接比特浏览器并执行本次充值
              </el-button>
              <p class="recharge-note">
                {{
                  operationMode === 'open_browser'
                    ? '登录资料只发送到本机连接器内存；登录成功后保留比特浏览器窗口供手动操作。'
                    : '登录资料、完整卡号和安全码只发送到本机连接器内存，不进入生产数据库或日志。'
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
          <RechargeResult v-if="selected" :job="selected" />
          <div v-else class="recharge-empty">
            <p>
              {{
                operationMode === 'open_browser' ? '等待打开比特浏览器窗口。' : '等待开始本次充值。'
              }}
            </p>
            <p>
              {{
                operationMode === 'open_browser'
                  ? '连接器会新建比特浏览器窗口并登录官网，完成后保留窗口供手动操作。'
                  : '连接器会新建比特浏览器窗口，官网登录核对后完成核价与付款保护。'
              }}
            </p>
          </div>
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

    <RechargeBrowserSettings :settings="browserSettings" />

    <el-drawer
      v-model="historyOpen"
      title="最近执行记录"
      size="min(640px, 96vw)"
      direction="rtl"
      destroy-on-close
    >
      <p class="recharge-note">
        查看历史记录不会重新连接、建单或付款；付款结果未知时可单独确认银行卡未收到请求。
      </p>
      <ul class="recharge-history">
        <li v-for="job in jobs" :key="job.id">
          <button
            type="button"
            :aria-pressed="historyJob?.id === job.id"
            :class="{ 'is-selected': historyJob?.id === job.id }"
            @click="selectHistory(job.id)"
          >
            {{ planLabels[job.plan] }} · {{ statusLabel(job.result.status || job.state) }}
            <small>{{ formatV2DateTime(job.createdAt) }}</small>
          </button>
        </li>
      </ul>
      <RechargeResult v-if="historyJob" :job="historyJob" />
      <div v-if="canRecheck || canResolveNoBankRequest" class="recharge-actions">
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
      </div>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { V2_RECHARGE_PLANS } from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import RechargeResult from './RechargeResult.vue';
import RechargeBrowserSettings from './RechargeBrowserSettings.vue';
import RechargeTotpFields from './RechargeTotpFields.vue';
import { formatRechargeExpiry, rechargeFields, rechargeRules } from './recharge-form';
import { currencyOptions, planLabels, statusLabel } from './recharge-presentation';
import { useAutoRecharge } from './useAutoRecharge';
const paymentFields = rechargeFields.filter((field) =>
  ['number', 'name', 'expiry', 'cvc'].includes(field.key)
);
const historyOpen = ref(false);
const historyId = ref('');
const {
  query,
  addressQuery,
  jobs,
  availableAddresses,
  selectedAddress,
  selectedAddressId,
  selected,
  jsonInput,
  sessionJson,
  jsonError,
  loginMethod,
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
const historyJob = computed(() => jobs.value.find((job) => job.id === historyId.value));
function selectHistory(id: string) {
  historyId.value = id;
  selectJob(id);
}
</script>

<style scoped src="./auto-recharge.css"></style>
