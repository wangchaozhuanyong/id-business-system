<template>
  <div class="recharge-result">
    <template v-if="job">
      <p class="recharge-status" role="status">
        {{ statusLabel(job.state === 'confirming' ? job.state : job.result.status || job.state) }}
      </p>
      <p v-if="job.result.initial_quote" class="recharge-quote-title">初始报价（填写账单地址前）</p>
      <dl v-if="job.result.initial_quote" class="recharge-summary recharge-quote">
        <dt>初始应付</dt>
        <dd class="recharge-total">
          {{ price(job.result.initial_quote.today, '需填写账单地址后确定') }}
        </dd>
        <dt>初始税费</dt>
        <dd>{{ price(job.result.initial_quote.tax, '需填写账单地址后确定') }}</dd>
        <dt>初始续费</dt>
        <dd>{{ price(job.result.initial_quote.renewal, '需填写账单地址后确定') }}</dd>
      </dl>
      <p class="recharge-quote-title">
        {{ job.result.initial_quote ? '账单地址后最终金额' : '官方报价' }}
      </p>
      <dl class="recharge-summary recharge-quote">
        <dt>今日应付</dt>
        <dd class="recharge-total">{{ price(job.result.quote?.today, quotePlaceholder(job)) }}</dd>
        <dt>税费</dt>
        <dd>
          {{ price(job.result.quote?.tax, quotePlaceholder(job))
          }}{{ job.result.quote?.tax_status === 'estimated' ? '（预估）' : '' }}
        </dd>
        <dt>续费</dt>
        <dd>
          {{ price(job.result.quote?.renewal, quotePlaceholder(job))
          }}{{
            job.result.quote?.renewal_interval === 'monthly'
              ? ' / 月，直至取消'
              : job.result.quote
                ? '，周期未知'
                : ''
          }}
        </dd>
      </dl>
      <dl class="recharge-summary">
        <dt>开通套餐</dt>
        <dd>{{ planLabels[job.plan] }}</dd>
        <dt>账户核对</dt>
        <dd>{{ job.result.account_matched ? '与 JSON 对应账户一致' : '尚未核实' }}</dd>
        <dt>当前套餐</dt>
        <dd>{{ statusLabel(job.result.current_plan) }}</dd>
        <dt v-if="job.result.card_last4">银行卡尾号</dt>
        <dd v-if="job.result.card_last4">{{ job.result.card_last4 }}</dd>
        <dt>执行阶段</dt>
        <dd>{{ statusLabel(job.result.stage) }}</dd>
        <dt v-if="job.result.window_name">窗口名称</dt>
        <dd v-if="job.result.window_name">{{ job.result.window_name }}</dd>
        <dt v-if="job.result.locked_currency">付款保护</dt>
        <dd v-if="job.result.locked_currency">
          锁定 {{ job.result.locked_currency }}，最高 {{ job.result.max_amount }}
        </dd>
        <dt>付款状态</dt>
        <dd>{{ paymentStatusLabel(job) }}</dd>
        <dt>开通状态</dt>
        <dd>{{ subscriptionLabel(job) }}</dd>
      </dl>
      <section v-if="issue" class="recharge-issue" role="alert" aria-live="polite">
        <strong>{{ issue.title }}</strong>
        <p>{{ issue.message }}</p>
        <p>{{ issue.action }}</p>
      </section>
      <p
        v-if="job.result.operator_resolution === 'confirmed_no_bank_request'"
        class="recharge-note"
        role="status"
      >
        已确认银行卡未收到付款请求；原付款尝试记录和确认次数已保留，历史付款锁已解除。
      </p>
      <p v-if="job.result.quote_wait_seconds" class="recharge-note" role="status">
        第 {{ job.result.session_attempt ?? 1 }} /
        {{ job.result.session_attempt_limit ?? 1 }} 次窗口尝试， 报价页已等待
        {{ job.result.quote_elapsed_seconds ?? 0 }} 秒，最多
        {{ job.result.quote_wait_seconds }} 秒。
      </p>
      <p v-else-if="job.result.session_attempt" class="recharge-note" role="status">
        第 {{ job.result.session_attempt }} / {{ job.result.session_attempt_limit }} 次尝试，
        本轮已等待 {{ job.result.session_elapsed_seconds ?? 0 }} 秒， 最多
        {{ job.result.session_wait_seconds }} 秒。
        <span v-if="job.result.session_step && job.result.stage === 'session_restore'"
          >{{ statusLabel(job.result.session_step) }}。</span
        >
      </p>
      <p v-if="job.result.session_refresh_count" class="recharge-note" role="status">
        当前窗口加载失败后已自动刷新
        {{ job.result.session_refresh_count }} 次；刷新仍失败才会清理并重建窗口。
      </p>
      <p v-if="job.result.quote_refresh_count" class="recharge-note" role="status">
        当前报价页没有有效内容，已自动刷新 {{ job.result.quote_refresh_count }} 次并继续等待。
      </p>
      <p v-if="job.result.stale_profiles_cleaned" class="recharge-note" role="status">
        已关闭并清理 {{ job.result.stale_profiles_cleaned }} 个属于该账号的历史付款前失败窗口。
      </p>
      <slot />
      <details class="recharge-diagnostics">
        <summary>执行详情</summary>
        <dl class="recharge-summary">
          <dt>记录时间</dt>
          <dd>{{ formatV2DateTime(job.createdAt) }}</dd>
          <dt>{{ job.action === 'bitbrowser' ? '浏览器出口' : '服务器出口' }}</dt>
          <dd>
            {{ job.result.network?.ip || '出口未确认' }} ·
            {{ job.result.network?.country || '地区未知' }}
          </dd>
          <template v-if="job.result.error_type || job.result.browser_error_code">
            <dt>浏览器异常</dt>
            <dd>{{ browserFailureLabel(job.result.error_type, job.result.browser_error_code) }}</dd>
          </template>
          <template v-if="job.result.last_reason">
            <dt>最后失败原因</dt>
            <dd>{{ failureReasonLabel(job.result.last_reason) }}</dd>
          </template>
          <template v-if="job.result.page_state">
            <dt>报价页状态</dt>
            <dd>{{ statusLabel(job.result.page_state) }}</dd>
          </template>
          <template v-if="job.result.payment_failure_reason">
            <dt>付款失败原因</dt>
            <dd>{{ paymentFailureLabel(job.result.payment_failure_reason) }}</dd>
          </template>
          <dt>订单编号</dt>
          <dd>{{ job.result.checkout_identifier || '尚未取得' }}</dd>
        </dl>
        <p v-if="job.result.diagnostics?.step">
          套餐步骤：{{ selectionStepLabels[job.result.diagnostics.step] }}。
        </p>
        <p v-if="job.result.diagnostics?.available_plans?.length">
          已识别选项：{{
            job.result.diagnostics.available_plans.map((plan) => planLabels[plan]).join('、')
          }}。
        </p>
      </details>
    </template>
    <div v-else class="recharge-empty">
      <h3>等待开通资料</h3>
      <p>补齐开通资料后，连接器会创建比特浏览器窗口并执行本次任务。</p>
      <p>官网要求本人验证时，会保留原窗口等待处理。</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { V2RechargeJob } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import {
  browserFailureLabel,
  failureReasonLabel,
  planLabels,
  paymentFailureLabel,
  paymentStatusLabel,
  rechargeIssueFeedback,
  statusLabel,
  quotePlaceholder,
  subscriptionLabel,
  selectionStepLabels
} from './recharge-presentation';
const props = defineProps<{ job?: V2RechargeJob }>();
const issue = computed(() => (props.job ? rechargeIssueFeedback(props.job) : null));
function price(value: { currency: string; amount: string } | null | undefined, fallback = '未知') {
  return value ? `${value.currency} ${value.amount}` : fallback;
}
</script>
<style scoped src="./auto-recharge.css"></style>
