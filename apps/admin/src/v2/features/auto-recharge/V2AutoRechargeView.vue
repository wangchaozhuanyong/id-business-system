<template>
  <section class="v2-records-page recharge-page">
    <V2PageContext description="输入授权 JSON → 选择套餐 → 填写资料 → 确认充值 → 查看开通结果。">
      <template #actions><el-button @click="historyOpen = true">最近执行记录</el-button></template>
    </V2PageContext>
    <V2AsyncRegion
      skeleton="form"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在读取执行记录"
      error-title="执行记录加载失败"
      @retry="refresh"
    >
      <div class="recharge-grid">
        <section class="recharge-panel" aria-labelledby="recharge-input-title">
          <div class="recharge-section-heading">
            <h2 id="recharge-input-title">填写开通资料</h2>
            <span>单账户 · 单笔执行</span>
          </div>
          <el-form
            :model="{ jsonInput: jsonInput || sessionJson, plan }"
            :rules="accountRules"
            scroll-to-error
            label-position="left"
            label-width="96px"
            require-asterisk-position="right"
            @submit.prevent
          >
            <el-form-item label="授权 JSON" prop="jsonInput" required :error="jsonError">
              <div class="recharge-json-row">
                <el-input
                  v-model="jsonInput"
                  type="password"
                  autocomplete="off"
                  :disabled="accountLocked"
                  :placeholder="
                    sessionJson ? '授权已载入，可粘贴新 JSON 替换' : '粘贴完整的授权 JSON'
                  "
                  @change="acceptSession"
                />
                <label class="recharge-file-control" :class="{ 'is-disabled': accountLocked }"
                  >导入文件
                  <input
                    type="file"
                    accept=".json,.txt"
                    aria-label="导入授权 JSON 文件"
                    :disabled="accountLocked"
                    @change="importJson"
                  />
                </label>
              </div>
            </el-form-item>
            <el-form-item label="开通套餐" prop="plan" required>
              <el-select
                v-model="plan"
                :disabled="accountLocked"
                placeholder="选择需要开通的套餐"
                aria-label="开通套餐"
              >
                <el-option
                  v-for="(label, key) in planLabels"
                  :key="key"
                  :label="label"
                  :value="key"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <p v-if="sessionJson" class="recharge-note">授权已载入，仅在本页内存使用。</p>
          <el-form
            :model="details"
            :rules="rechargeRules"
            scroll-to-error
            label-position="left"
            label-width="96px"
            require-asterisk-position="right"
            @submit.prevent
          >
            <fieldset
              class="recharge-billing"
              :disabled="billingLocked"
              @focusin="editingDetails = true"
              @focusout="editingDetails = false"
            >
              <legend>付款资料</legend>
              <div class="recharge-fields">
                <el-form-item
                  v-for="field in cardFields"
                  :key="field.key"
                  :label="field.label"
                  :prop="field.key"
                  :required="field.required"
                >
                  <el-input
                    v-model="details[field.key]"
                    :type="field.secret ? 'password' : 'text'"
                    autocomplete="off"
                    :maxlength="field.max"
                    :placeholder="field.placeholder"
                    :disabled="billingLocked"
                    :validate-event="!billingLocked"
                  />
                </el-form-item>
              </div>
              <h3>账单地址</h3>
              <div class="recharge-fields">
                <el-form-item
                  v-for="field in billingFields"
                  :key="field.key"
                  :label="field.label"
                  :prop="field.key"
                  :required="field.required"
                >
                  <el-input
                    v-model="details[field.key]"
                    autocomplete="off"
                    :maxlength="field.max"
                    :placeholder="field.placeholder"
                    :disabled="billingLocked"
                    :validate-event="!billingLocked"
                  />
                </el-form-item>
              </div>
            </fieldset>
          </el-form>
          <div class="recharge-form-footer">
            <p class="recharge-note">资料填完并离开输入框后自动核价。确认充值前不会付款。</p>
            <p class="recharge-note">
              卡号及安全码仅用于本次任务，提交准备后清除，不保存为卡片库。
            </p>
          </div>
        </section>
        <section class="recharge-panel" aria-labelledby="recharge-result-title">
          <div class="recharge-section-heading">
            <h2 id="recharge-result-title">开通信息</h2>
            <span>金额与状态由官网回传</span>
          </div>
          <p class="recharge-workflow" role="status">{{ workflowMessage }}</p>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <RechargeResult :job="selected">
            <div v-if="selected?.state === 'awaiting_confirmation'" class="recharge-confirm">
              <p>点击确认即授权本次付款及上述续费；系统将执行充值并回传开通结果。</p>
              <el-button
                type="primary"
                :disabled="Boolean(confirmationBlockedReason)"
                :loading="busy"
                @click="confirmPayment"
              >
                确认充值 · {{ selected.result.quote?.today?.currency }}
                {{ selected.result.quote?.today?.amount }}
              </el-button>
              <p v-if="confirmationBlockedReason" role="status">{{ confirmationBlockedReason }}</p>
            </div>
          </RechargeResult>
          <div class="recharge-actions">
            <el-button
              v-if="selected && ['running', 'awaiting_confirmation'].includes(selected.state)"
              :disabled="busy"
              @click="cancel"
              >停止本次任务</el-button
            >
            <el-button v-if="canRecheck" :disabled="busy" @click="recheckPayment"
              >复查原单开通状态</el-button
            >
            <el-button v-if="canRetry" :disabled="busy" @click="retryPreparation"
              >重试核价</el-button
            >
            <el-button
              v-if="error || selected?.state === 'unknown'"
              :disabled="busy || query.phase.value === 'refreshing'"
              @click="refresh"
              >刷新原任务状态</el-button
            >
          </div>
        </section>
      </div>
    </V2AsyncRegion>
    <el-drawer
      v-model="historyOpen"
      title="最近执行记录"
      size="min(640px, 96vw)"
      direction="rtl"
      destroy-on-close
    >
      <p class="recharge-note">仅查看历史记录，不会切换或重新执行当前充值任务。</p>
      <p v-if="query.error.value" class="recharge-error" role="alert">
        {{ getApiErrorMessage(query.error.value) }}
      </p>
      <el-button
        :disabled="query.phase.value === 'refreshing' || query.phase.value === 'initial-loading'"
        @click="refresh"
        >刷新记录</el-button
      >
      <p v-if="!jobs.length && query.phase.value === 'ready'" class="recharge-note">
        暂无执行记录。
      </p>
      <ul class="recharge-history">
        <li v-for="job in jobs" :key="job.id">
          <button
            type="button"
            :aria-pressed="historyJob?.id === job.id"
            :class="{ 'is-selected': historyJob?.id === job.id }"
            @click="historyId = job.id"
          >
            {{ planLabels[job.plan] }} · {{ statusLabel(job.result.status || job.state) }}
            <small>{{ formatV2DateTime(job.createdAt) }}</small>
          </button>
        </li>
      </ul>
      <RechargeResult v-if="historyJob" :job="historyJob" />
    </el-drawer>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import RechargeResult from './RechargeResult.vue';
import { useAutoRecharge } from './useAutoRecharge';
import { rechargeFields, rechargeRules } from './recharge-form';
import { planLabels, statusLabel } from './recharge-presentation';
const {
  query,
  jobs,
  selected,
  jsonInput,
  sessionJson,
  jsonError,
  plan,
  busy,
  error,
  details,
  editingDetails,
  accountLocked,
  billingLocked,
  confirmationBlockedReason,
  canRetry,
  canRecheck,
  recheckPayment,
  workflowMessage,
  acceptSession,
  confirmPayment,
  cancel,
  importJson,
  refresh,
  retryPreparation
} = useAutoRecharge();
const accountRules: FormRules = {
  plan: [{ required: true, message: '请选择需要开通的套餐', trigger: 'change' }],
  jsonInput: [
    {
      trigger: 'blur',
      validator: (_rule, _value, callback) => {
        callback(
          jsonError.value || !sessionJson.value
            ? new Error(jsonError.value || '请提供授权 JSON')
            : undefined
        );
      }
    }
  ]
};
const historyOpen = ref(false);
const historyId = ref('');
const historyJob = computed(
  () => jobs.value.find((job) => job.id === historyId.value) ?? jobs.value[0]
);
const cardFields = computed(() =>
  rechargeFields.slice(0, 4).map((field) => ({
    ...field,
    placeholder:
      selected.value?.action === 'prepare' &&
      !details.value[field.key] &&
      ['number', 'expiry', 'cvc'].includes(field.key)
        ? '敏感资料已清除'
        : field.placeholder
  }))
);
const billingFields = rechargeFields.slice(4);
</script>
<style scoped src="./auto-recharge.css"></style>
