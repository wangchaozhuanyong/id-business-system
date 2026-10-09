<template>
  <div class="recharge-result">
    <template v-if="job">
      <p class="recharge-status" role="status">
        {{ statusLabel(job.state === 'confirming' ? job.state : job.result.status || job.state) }}
      </p>
      <template v-if="job.result.mode !== 'open_browser'">
        <p v-if="job.result.initial_quote" class="recharge-quote-title">
          初始报价（填写账单地址前）
        </p>
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
          <dd class="recharge-total">
            {{ price(job.result.quote?.today, quotePlaceholder(job)) }}
          </dd>
          <template v-if="job.result.quote?.credit">
            <dt>折抵金额</dt>
            <dd>{{ price(job.result.quote.credit) }}</dd>
          </template>
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
      </template>
      <dl class="recharge-summary">
        <dt>执行模式</dt>
        <dd>
          {{
            job.action === 'server'
              ? '历史服务器充值'
              : job.result.mode === 'open_browser'
                ? '仅登录账号'
                : '比特浏览器充值'
          }}
        </dd>
        <template v-if="job.result.mode !== 'open_browser'">
          <dt>目标套餐</dt>
          <dd>{{ planLabels[job.plan] }}</dd>
        </template>
        <dt v-if="job.result.mode !== 'open_browser'">本次操作</dt>
        <dd v-if="job.result.mode !== 'open_browser'">{{ operationLabel(job) }}</dd>
        <dt>账户核对</dt>
        <dd>{{ accountVerificationLabel(job) }}</dd>
        <template v-if="job.result.current_plan_before">
          <dt>升级前套餐</dt>
          <dd>{{ statusLabel(job.result.current_plan_before) }}</dd>
        </template>
        <dt>当前套餐</dt>
        <dd>{{ officialCurrentPlanLabel(job) }}</dd>
        <template v-if="job.result.subscription_period">
          <dt>套餐生效</dt>
          <dd>{{ formatV2DateTime(job.result.subscription_period.start) }}</dd>
          <dt>当前周期结束</dt>
          <dd>{{ formatV2DateTime(job.result.subscription_period.end) }}</dd>
        </template>
        <dt v-if="job.result.card_last4">银行卡尾号</dt>
        <dd v-if="job.result.card_last4">{{ job.result.card_last4 }}</dd>
        <dt>执行阶段</dt>
        <dd>{{ executionStageLabel(job) }}</dd>
        <template v-if="job.result.session_phase && job.result.stage === 'session_restore'">
          <dt>核实阶段</dt>
          <dd>{{ sessionPhaseLabel(job.result.session_phase) }}</dd>
        </template>
        <dt v-if="job.result.browser_profile_id">执行窗口</dt>
        <dd v-if="job.result.browser_profile_id">{{ job.result.browser_profile_id }}</dd>
        <dt v-if="job.result.window_name">窗口名称</dt>
        <dd v-if="job.result.window_name">{{ job.result.window_name }}</dd>
        <dt v-if="job.result.locked_currency">付款币种</dt>
        <dd v-if="job.result.locked_currency">{{ job.result.locked_currency }}</dd>
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
      <p v-if="proxyProgress" class="recharge-note" role="status">{{ proxyProgress }}</p>
      <p v-else-if="job.result.quote_wait_seconds" class="recharge-note" role="status">
        第 {{ job.result.session_attempt ?? 1 }} /
        {{ job.result.session_attempt_limit ?? 1 }} 次窗口尝试， 报价页已等待
        {{ job.result.quote_elapsed_seconds ?? 0 }} 秒，最多
        {{ job.result.quote_wait_seconds }} 秒。
      </p>
      <p
        v-else-if="job.result.session_wait_seconds && job.result.stage === 'session_restore'"
        class="recharge-note"
        role="status"
      >
        <template v-if="job.result.session_attempt">
          第 {{ job.result.session_attempt }} / {{ job.result.session_attempt_limit }} 次尝试，
        </template>
        本轮已等待 {{ job.result.session_elapsed_seconds ?? 0 }} 秒， 最多
        {{ job.result.session_wait_seconds }} 秒。
        <span v-if="job.result.session_step && job.result.stage === 'session_restore'"
          >{{ statusLabel(job.result.session_step) }}。</span
        >
      </p>
      <p v-if="job.result.session_refresh_count" class="recharge-note" role="status">
        当前窗口加载失败后已自动刷新
        {{ job.result.session_refresh_count }} 次；{{
          job.action === 'server'
            ? '恢复期间沿用原窗口和代理，仍失败时停止本次任务。'
            : '刷新仍失败才会清理并重建窗口。'
        }}
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
          <template v-if="job.result.first_session_verified_at">
            <dt>首次核实成功</dt>
            <dd>{{ formatV2DateTime(job.result.first_session_verified_at) }}</dd>
          </template>
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
      <h3>{{ mode === 'open_browser' ? '等待打开比特浏览器窗口' : '等待开始本次充值' }}</h3>
      <p v-if="mode === 'open_browser'">
        网页会直接连接当前电脑的比特浏览器并登录官网，完成后保留窗口供手动操作。
      </p>
      <p v-else>
        本机充值助手连接比特浏览器，核实账号与当前套餐，取得开通或升级报价后等待你确认付款。
      </p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { V2RechargeJob } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import {
  browserFailureLabel,
  accountVerificationLabel,
  officialCurrentPlanLabel,
  executionStageLabel,
  sessionPhaseLabel,
  failureReasonLabel,
  planLabels,
  paymentFailureLabel,
  paymentStatusLabel,
  rechargeIssueFeedback,
  statusLabel,
  proxyAttemptLabel,
  quotePlaceholder,
  subscriptionLabel,
  selectionStepLabels
} from './recharge-presentation';
const props = defineProps<{
  job?: V2RechargeJob;
  mode?: 'payment' | 'open_browser';
}>();
defineEmits<{ refresh: [] }>();
function operationLabel(job: V2RechargeJob) {
  if (job.result.status === 'already_subscribed') return '已开通，无需重复付款';
  if (job.result.operation === 'subscription_upgrade')
    return `${statusLabel(job.result.current_plan_before || '')} → ${planLabels[job.plan]} 升级`;
  return job.result.account_matched ? '开通（以官网核实为准）' : '等待官网核实';
}
const issue = computed(() => (props.job ? rechargeIssueFeedback(props.job) : null));
const proxyProgress = computed(() => (props.job ? proxyAttemptLabel(props.job) : ''));
function price(value: { currency: string; amount: string } | null | undefined, fallback = '未知') {
  return value ? `${value.currency} ${value.amount}` : fallback;
}
</script>
<style scoped src="./auto-recharge.css"></style>
