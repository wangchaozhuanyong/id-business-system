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
        <dt>付款状态</dt>
        <dd>{{ paymentStatusLabel(job) }}</dd>
        <dt>开通状态</dt>
        <dd>{{ subscriptionLabel(job) }}</dd>
      </dl>
      <p v-if="job.result.reason" class="recharge-error" role="alert">
        {{ statusLabel(job.result.reason) }}
      </p>
      <slot />
      <details class="recharge-diagnostics">
        <summary>执行详情</summary>
        <dl class="recharge-summary">
          <dt>记录时间</dt>
          <dd>{{ formatV2DateTime(job.createdAt) }}</dd>
          <dt>服务器出口</dt>
          <dd>
            {{ job.result.network?.ip || '出口未确认' }} ·
            {{ job.result.network?.country || '地区未知' }}
          </dd>
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
      <p>载入授权 JSON 并选择套餐后，点击“获取初始报价”才会访问官网。</p>
      <p>核价完成后，在这里确认充值并查看开通结果。</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import type { V2RechargeJob } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import {
  planLabels,
  paymentStatusLabel,
  statusLabel,
  quotePlaceholder,
  subscriptionLabel,
  selectionStepLabels
} from './recharge-presentation';
defineProps<{ job?: V2RechargeJob }>();
function price(value: { currency: string; amount: string } | null | undefined, fallback = '未知') {
  return value ? `${value.currency} ${value.amount}` : fallback;
}
</script>
<style scoped src="./auto-recharge.css"></style>
