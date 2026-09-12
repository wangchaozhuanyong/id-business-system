<template>
  <section class="recharge-page">
    <V2PageContext
      description="载入授权 JSON，连接本机比特浏览器并按金额上限自动执行；需要真人或银行验证时保留原窗口等待处理。"
    >
      <template #status>
        <span class="recharge-connector-status" :data-status="connectorStatus">
          {{ connectorMessage }}
        </span>
      </template>
      <template #actions>
        <el-button @click="settingsOpen = true">比特浏览器设置</el-button>
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
            <span>单账户 · 单窗口 · 单次付款</span>
          </div>

          <el-form
            :model="details"
            :rules="rechargeRules"
            label-position="left"
            label-width="112px"
            require-asterisk-position="right"
            :disabled="formLocked"
          >
            <el-form-item label="授权 JSON" required :error="jsonError">
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
                授权已自动载入，账单邮箱已读取。
              </p>
            </el-form-item>

            <div class="recharge-fields">
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

            <fieldset class="recharge-billing">
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
                    :readonly="field.key === 'email'"
                    autocomplete="off"
                  />
                </el-form-item>
              </div>

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

            <div class="recharge-authorization">
              <el-checkbox v-model="authorizeSinglePayment">
                我已核对锁定币种和最高付款金额，授权本任务最多提交一次官网付款
              </el-checkbox>
              <p class="recharge-note">
                官网币种不一致、今日应付超过上限、税费或订单金额不明确时立即停止；不会换币种或重试付款。
              </p>
            </div>

            <div class="recharge-form-footer">
              <el-button type="primary" :disabled="!canStart" :loading="busy" @click="start">
                连接比特浏览器并执行本次充值
              </el-button>
              <p class="recharge-note">
                JSON、完整卡号和安全码只发送到本机连接器内存，不进入生产数据库或日志。
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
            <p>等待开始本次充值。</p>
            <p>连接器会新建并打开比特浏览器窗口，恢复 JSON 登录后完成核价与付款保护。</p>
          </div>
          <div class="recharge-actions">
            <el-button v-if="needsHuman" type="primary" :loading="busy" @click="resume">
              我已完成验证，继续原任务
            </el-button>
            <el-button v-if="canCancel" :disabled="busy" @click="cancel">停止本次任务</el-button>
            <el-button v-if="canRecheck" type="primary" :loading="busy" @click="recheck">
              只读复查原订单
            </el-button>
            <el-button :disabled="busy || query.phase.value === 'refreshing'" @click="refresh">
              刷新原任务状态
            </el-button>
          </div>
        </section>
      </div>
    </V2AsyncRegion>

    <el-drawer
      v-model="settingsOpen"
      title="比特浏览器设置"
      size="min(720px, 96vw)"
      direction="rtl"
      :close-on-click-modal="!settingsSaving"
      :close-on-press-escape="!settingsSaving"
    >
      <p v-if="settingsQuery.error.value" class="recharge-error" role="alert">
        {{ getApiErrorMessage(settingsQuery.error.value) }}
        <el-button link type="primary" @click="settingsQuery.refresh">重试</el-button>
      </p>
      <el-form
        :model="settingsForm"
        label-position="left"
        label-width="168px"
        require-asterisk-position="right"
        :disabled="settingsSaving"
      >
        <el-form-item label="本机连接器地址" required>
          <el-input v-model="settingsForm.connectorUrl" />
        </el-form-item>
        <el-form-item label="比特 Local API" required>
          <el-input v-model="settingsForm.localApiUrl" />
        </el-form-item>
        <el-form-item label="比特接口密钥" required>
          <el-input
            v-model="settingsForm.localApiToken"
            type="password"
            show-password
            autocomplete="off"
            :placeholder="
              settingsQuery.data.value?.localApiTokenMask || '填写比特浏览器系统设置中的密钥'
            "
          />
        </el-form-item>
        <el-form-item label="本机连接密钥" required>
          <el-input
            v-model="settingsForm.connectorToken"
            type="password"
            show-password
            autocomplete="off"
            :placeholder="
              settingsQuery.data.value?.connectorTokenMask || '填写连接器启动时显示的密钥'
            "
          />
        </el-form-item>
        <el-form-item label="窗口分组" required>
          <el-input v-model="settingsForm.groupName" maxlength="80" />
        </el-form-item>
        <el-form-item label="标签／窗口备注" required>
          <el-input v-model="settingsForm.tagName" maxlength="80" />
        </el-form-item>
        <el-form-item label="动态代理协议" required>
          <el-select v-model="settingsForm.proxyType">
            <el-option label="HTTP" value="http" />
            <el-option label="HTTPS" value="https" />
            <el-option label="SOCKS5 代理" value="socks5" />
          </el-select>
        </el-form-item>
        <el-form-item label="动态 IP 提取链接" required>
          <el-input
            v-model="settingsForm.dynamicProxyUrl"
            type="password"
            show-password
            autocomplete="off"
            :placeholder="settingsQuery.data.value?.dynamicProxyUrlMask || '粘贴动态 IP 提取链接'"
          />
        </el-form-item>
      </el-form>

      <div class="recharge-fixed-settings">
        <div><span>登录网址</span><strong>系统固定 ChatGPT 官网</strong></div>
        <div><span>提取方式</span><strong>每次新建窗口提取新 IP</strong></div>
        <div><span>代理服务商</span><strong>通用</strong></div>
        <div><span>浏览器语言</span><strong>简体中文，不跟随 IP</strong></div>
        <div><span>界面语言</span><strong>简体中文，不跟随 IP</strong></div>
      </div>
      <p class="recharge-note">
        启动命令：<code
          >npm run auto-recharge:connector -- --allowed-origin=https://你的管理端域名</code
        >
      </p>
      <div class="recharge-drawer-actions">
        <el-button :loading="connectorStatus === 'checking'" @click="testConnector"
          >检测连接器</el-button
        >
        <el-button type="primary" :loading="settingsSaving" @click="saveSettings"
          >保存设置</el-button
        >
      </div>
    </el-drawer>

    <el-drawer
      v-model="historyOpen"
      title="最近执行记录"
      size="min(640px, 96vw)"
      direction="rtl"
      destroy-on-close
    >
      <p class="recharge-note">历史记录只读，不会重新连接、建单或付款。</p>
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
      <div v-if="canRecheck" class="recharge-actions">
        <el-button type="primary" :loading="busy" @click="recheck">只读复查原订单</el-button>
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
import { formatRechargeExpiry, rechargeFields, rechargeRules } from './recharge-form';
import { currencyOptions, planLabels, statusLabel } from './recharge-presentation';
import { useAutoRecharge } from './useAutoRecharge';
const paymentFields = rechargeFields.filter((field) =>
  ['number', 'name', 'expiry', 'cvc', 'email'].includes(field.key)
);
const historyOpen = ref(false);
const historyId = ref('');
const {
  query,
  addressQuery,
  settingsQuery,
  jobs,
  availableAddresses,
  selectedAddress,
  selectedAddressId,
  selected,
  jsonInput,
  sessionJson,
  jsonError,
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
  canStart,
  canCancel,
  canRecheck,
  needsHuman,
  workflowMessage,
  settingsOpen,
  settingsSaving,
  settingsForm,
  connectorStatus,
  connectorMessage,
  updateJsonInput,
  importJson,
  start,
  recheck,
  selectJob,
  resume,
  cancel,
  refresh,
  testConnector,
  saveSettings
} = useAutoRecharge();
const historyJob = computed(() => jobs.value.find((job) => job.id === historyId.value));
function selectHistory(id: string) {
  historyId.value = id;
  selectJob(id);
}
</script>

<style scoped src="./auto-recharge.css"></style>
