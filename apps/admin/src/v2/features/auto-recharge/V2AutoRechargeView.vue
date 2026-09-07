<template>
  <section class="v2-records-page recharge-page">
    <p class="recharge-intro">
      授权 JSON → 核对账户 → 获取官方报价 → 填写资料 → 确认开通。当前为单账户、单笔执行。
    </p>
    <el-alert
      title="真实扣款与订阅生效尚未验收。确认金额前不会付款；未知结果只能复查原订单。"
      type="warning"
      :closable="false"
    />
    <p v-if="error" role="alert" class="recharge-error">{{ error }}</p>
    <div class="recharge-grid">
      <section class="recharge-panel" aria-labelledby="recharge-input-title">
        <h2 id="recharge-input-title">账户与付款资料</h2>
        <el-form
          label-position="left"
          label-width="110px"
          require-asterisk-position="right"
          @submit.prevent
        >
          <el-form-item label="授权 JSON" required>
            <el-input
              v-model="jsonInput"
              type="password"
              autocomplete="off"
              :disabled="active || busy"
              placeholder="粘贴完整 JSON，载入后清空输入框"
            />
          </el-form-item>
          <div class="recharge-file">
            <label
              >从文件导入
              <input
                type="file"
                accept=".json,.txt"
                :disabled="active || busy"
                @change="importJson"
            /></label>
          </div>
          <p v-if="sessionJson" class="recharge-note">JSON 已载入本页内存，离开页面后清除。</p>
          <el-form-item label="订阅套餐" required>
            <el-select v-model="plan" :disabled="active || busy" aria-label="订阅套餐">
              <el-option
                v-for="(label, key) in planLabels"
                :key="key"
                :label="label"
                :value="key"
              />
            </el-select>
          </el-form-item>
          <div class="recharge-actions">
            <el-button :disabled="active || busy" @click="execute('check')">开始检查</el-button>
            <el-button type="primary" :disabled="active || busy" @click="execute('quote')"
              >获取官方报价</el-button
            >
            <el-button :disabled="active || busy" @click="clearSession">清除会话</el-button>
          </div>
          <p class="recharge-note">
            先取得所选套餐原结算，再准备付款。再次获取报价会读取原单，不自动换单。套餐是否可购由官网决定。
          </p>
          <fieldset :disabled="active || busy" class="recharge-billing">
            <legend>本次 Visa 与真实账单</legend>
            <el-form-item
              v-for="field in fields"
              :key="field.key"
              :label="field.label"
              :required="field.required"
            >
              <el-input
                v-model="details[field.key]"
                :type="field.secret ? 'password' : 'text'"
                autocomplete="off"
                :maxlength="field.max"
                :placeholder="field.placeholder"
              />
            </el-form-item>
          </fieldset>
          <p class="recharge-note">
            卡号及安全码只用于本次任务，不保存为卡片库。安全码提交后从输入框清除。
          </p>
          <el-button type="primary" :disabled="active || busy" @click="execute('prepare')"
            >填入官网并重新核价</el-button
          >
        </el-form>
      </section>
      <section class="recharge-panel" aria-labelledby="recharge-result-title">
        <h2 id="recharge-result-title">官方报价与执行结果</h2>
        <V2AsyncRegion
          skeleton="settings"
          :phase="query.phase.value"
          :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
          loading-title="正在读取执行记录"
          error-title="执行记录加载失败"
          @retry="query.refresh"
        >
          <p v-if="!selected">尚无执行记录。输入 JSON 后点击“开始检查”。</p>
          <template v-else>
            <p class="recharge-status" role="status">
              {{ statusLabel(selected.result.status || selected.state) }}
            </p>
            <dl class="recharge-summary">
              <dt>账户核对</dt>
              <dd>{{ selected.result.account_matched ? '与 JSON 对应账户一致' : '尚未核实' }}</dd>
              <dt>当前套餐</dt>
              <dd>{{ statusLabel(selected.result.current_plan) }}</dd>
              <dt>目标套餐</dt>
              <dd>{{ planLabels[selected.plan] }}</dd>
              <dt>服务器出口</dt>
              <dd>
                {{ selected.result.network?.ip || '出口未确认' }} ·
                {{ selected.result.network?.country || '地区未知' }}
              </dd>
              <dt>今日应付</dt>
              <dd>{{ price(selected.result.quote?.today, quotePlaceholder(selected)) }}</dd>
              <dt>税费</dt>
              <dd>
                {{ price(selected.result.quote?.tax, quotePlaceholder(selected))
                }}{{ selected.result.quote?.tax_status === 'estimated' ? '（预估）' : '' }}
              </dd>
              <dt>续费</dt>
              <dd>
                {{ price(selected.result.quote?.renewal, quotePlaceholder(selected))
                }}{{
                  selected.result.quote?.renewal_interval === 'monthly'
                    ? ' / 月，直至取消'
                    : selected.result.quote
                      ? '，周期未知'
                      : ''
                }}
              </dd>
              <dt>付款状态</dt>
              <dd>{{ statusLabel(selected.result.payment_status || 'not_attempted') }}</dd>
              <dt>订阅结果</dt>
              <dd>
                {{ subscriptionLabel(selected) }}
              </dd>
              <dt>执行阶段</dt>
              <dd>{{ statusLabel(selected.result.stage) }}</dd>
              <dt>订单编号</dt>
              <dd>{{ selected.result.checkout_identifier || '尚未取得' }}</dd>
            </dl>
            <p v-if="selected.result.reason" role="alert">
              {{ statusLabel(selected.result.reason) }} <code>{{ selected.result.reason }}</code>
            </p>
            <p v-if="selected.result.diagnostics?.step">
              套餐步骤：{{ selectionStepLabels[selected.result.diagnostics.step] }}。
              <template v-if="selected.result.diagnostics.matched_count !== undefined">
                匹配控件：{{ selected.result.diagnostics.matched_count }} 个。
              </template>
              <template v-if="selected.result.diagnostics.enabled !== undefined">
                {{ selected.result.diagnostics.enabled ? '控件可操作。' : '控件暂不可操作。' }}
              </template>
              <template v-if="selected.result.diagnostics.available_plans?.length">
                已识别选项：{{
                  selected.result.diagnostics.available_plans
                    .map((plan) => planLabels[plan])
                    .join('、')
                }}。
              </template>
            </p>
            <div v-if="selected.state === 'awaiting_confirmation'" class="recharge-confirm">
              <p>
                本次 {{ planLabels[selected.plan] }}，Visa 尾号 {{ selected.result.card_last4 }}。
              </p>
              <el-checkbox v-model="confirmed"
                >我已核对今日应付、账单资料及按月续费，授权本次付款。</el-checkbox
              >
              <el-button
                type="primary"
                :disabled="!confirmed || busy || !selected.result.nonce"
                @click="confirmPayment"
                >确认开通 · {{ price(selected.result.quote?.today) }}</el-button
              >
              <p v-if="!selected.result.nonce">确认会话已失效，请停止等待后重新准备付款。</p>
            </div>
            <div class="recharge-actions">
              <el-button
                v-if="['running', 'awaiting_confirmation'].includes(selected.state)"
                :disabled="busy"
                @click="cancel"
                >停止等待</el-button
              >
              <el-button :disabled="busy" @click="query.refresh">刷新结果</el-button>
              <el-button :disabled="active || busy" @click="execute('recheck')"
                >复查所选套餐原付款</el-button
              >
            </div>
          </template>
        </V2AsyncRegion>
        <h3>最近执行记录</h3>
        <ul class="recharge-history">
          <li v-for="job in jobs" :key="job.id">
            <button
              type="button"
              @click="
                selectedId = job.id;
                confirmed = false;
              "
            >
              {{ planLabels[job.plan] }} · {{ statusLabel(job.result.status || job.state) }}
              <small>{{ formatV2DateTime(job.createdAt) }}</small>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>
<script setup lang="ts">
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useAutoRecharge } from './useAutoRecharge';
import {
  planLabels,
  statusLabel,
  quotePlaceholder,
  subscriptionLabel,
  selectionStepLabels
} from './recharge-presentation';
import type { V2RechargeDetails } from './contracts';
const {
  query,
  jobs,
  selected,
  active,
  jsonInput,
  sessionJson,
  plan,
  selectedId,
  busy,
  error,
  confirmed,
  details,
  execute,
  confirmPayment,
  cancel,
  importJson,
  clearSession
} = useAutoRecharge();
function price(value: { currency: string; amount: string } | null | undefined, fallback = '未知') {
  return value ? `${value.currency} ${value.amount}` : fallback;
}
const fields: {
  key: keyof V2RechargeDetails;
  label: string;
  required?: boolean;
  secret?: boolean;
  max: number;
  placeholder?: string;
}[] = [
  { key: 'number', label: 'Visa 卡号', required: true, secret: true, max: 23 },
  { key: 'expiry', label: '有效期', required: true, max: 5, placeholder: 'MM/YY' },
  { key: 'cvc', label: '安全码', required: true, secret: true, max: 4 },
  { key: 'name', label: '持卡人姓名', required: true, max: 120 },
  { key: 'email', label: '账单邮箱', required: true, max: 250 },
  {
    key: 'country',
    label: '账单国家',
    required: true,
    max: 2,
    placeholder: '真实国家两位代码，如 MY'
  },
  { key: 'line1', label: '街道地址', required: true, max: 250 },
  { key: 'line2', label: '地址第二行', max: 250 },
  { key: 'city', label: '城市', required: true, max: 120 },
  { key: 'state', label: '州／省', max: 120 },
  { key: 'postal_code', label: '邮编', required: true, max: 20 }
];
</script>
<style scoped>
.recharge-page {
  display: grid;
  gap: 18px;
}
.recharge-intro,
.recharge-note {
  margin: 0;
  color: var(--el-text-color-regular);
  line-height: 1.7;
}
.recharge-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.recharge-panel {
  min-width: 0;
  padding: 24px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
}
.recharge-panel h2 {
  margin: 0 0 24px;
  font-size: 18px;
}
.recharge-billing {
  border: 0;
  padding: 20px 0 0;
  margin: 16px 0 0;
}
.recharge-billing legend {
  font-weight: 600;
}
.recharge-file {
  margin-bottom: 18px;
  font-size: 13px;
}
.recharge-file input {
  max-width: 100%;
}
.recharge-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
}
.recharge-actions :deep(.el-button) {
  margin-left: 0;
}
.recharge-summary {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: 15px;
  font-size: 14px;
}
.recharge-summary dt {
  color: var(--el-text-color-regular);
}
.recharge-summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.recharge-status {
  font-size: 20px;
  font-weight: 600;
}
.recharge-confirm {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 16px;
  display: grid;
  gap: 14px;
}
.recharge-confirm :deep(.el-checkbox) {
  height: auto;
  white-space: normal;
}
.recharge-confirm :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.6;
}
.recharge-error {
  color: var(--el-color-danger);
}
.recharge-history {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 8px;
}
.recharge-history button {
  width: 100%;
  text-align: left;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  border-radius: 6px;
  cursor: pointer;
}
.recharge-history small {
  display: block;
  margin-top: 5px;
  color: var(--el-text-color-regular);
}
@media (max-width: 1000px) {
  .recharge-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 480px) {
  .recharge-panel {
    padding: 14px;
  }
  .recharge-summary {
    grid-template-columns: 86px minmax(0, 1fr);
  }
}
</style>
