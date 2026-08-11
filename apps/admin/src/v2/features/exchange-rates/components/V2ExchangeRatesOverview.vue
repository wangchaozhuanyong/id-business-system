<template>
  <section class="v2-exchange-overview-stack">
    <el-alert
      v-if="!page.runtime?.settings.emergencyNetworkEnabled"
      type="error"
      title="汇率网络采集已被环境紧急开关关闭"
      description="当前不会请求 Binance 或 OKX，也不会提供加卡自动汇率。"
      show-icon
      :closable="false"
    />
    <el-alert
      v-else-if="page.overview?.latestRun?.status === 'failed'"
      type="error"
      title="最新一次联网采集失败"
      :description="page.latestFailureDescription"
      show-icon
      :closable="false"
    />
    <el-alert
      v-else-if="page.overview?.lastSuccess?.stale"
      type="warning"
      title="上次成功汇率已过期"
      description="过期汇率仅供历史核对，不会自动带入加卡。"
      show-icon
      :closable="false"
    />

    <section class="v2-exchange-overview" aria-label="自动采集汇率概览">
      <div class="v2-exchange-overview__intro">
        <span class="v2-exchange-overview__eyebrow">FX CONTROL CENTER</span>
        <div class="v2-exchange-overview__title-row">
          <h2>实时汇率总览</h2>
          <el-tag
            :type="page.runtime?.settings.autoEnabled ? 'success' : 'info'"
            size="small"
            effect="plain"
          >
            自动采集{{ page.runtime?.settings.autoEnabled ? '已开启' : '已关闭' }}
          </el-tag>
        </div>
        <p>
          以 ¥{{
            page.formatAmount(page.runtime?.settings.targetAmountRmb)
          }}
          成交档采集，数据保留最近 {{ page.runtime?.retention.days ?? 30 }} 天。
        </p>
      </div>

      <div
        class="v2-exchange-overview__primary"
        :class="{ 'is-stale': page.overview?.lastSuccess?.stale }"
      >
        <span>联网采集中间价</span>
        <strong>{{ page.formatRate(page.overview?.lastSuccess?.snapshot?.midRateToRmb) }}</strong>
        <small>
          CNY / USDT
          <el-tag
            v-if="page.overview?.lastSuccess"
            :type="page.overview.lastSuccess.stale ? 'warning' : 'success'"
            size="small"
            effect="plain"
          >
            {{ page.overview.lastSuccess.stale ? '已过期' : '有效' }}
          </el-tag>
        </small>
      </div>

      <div class="v2-exchange-overview__actions" aria-label="汇率操作">
        <AppButton v-if="page.canCollect" :loading="page.collecting" @click="page.collectNow">
          <el-icon><VideoPlay /></el-icon>
          立即采集
        </AppButton>
        <AppButton v-if="page.canManage" variant="ghost" @click="page.openSettings">
          <el-icon><Setting /></el-icon>
          采集设置
        </AppButton>
        <AppButton v-if="page.canCreate" variant="ghost" @click="page.openManualCreate">
          <el-icon><Plus /></el-icon>
          人工汇率
        </AppButton>
        <AppButton variant="ghost" :disabled="page.headerLoading" @click="page.loadAll">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
      </div>

      <dl class="v2-exchange-overview__metrics" aria-label="汇率采集指标">
        <div>
          <dt>综合买入</dt>
          <dd>
            {{
              page.formatRate(
                page.overview?.lastSuccess?.snapshot?.combinedMerchantBuyAverageRateToRmb
              )
            }}
          </dd>
          <small>商家买入均价</small>
        </div>
        <div>
          <dt>综合卖出</dt>
          <dd>
            {{
              page.formatRate(
                page.overview?.lastSuccess?.snapshot?.combinedMerchantSellAverageRateToRmb
              )
            }}
          </dd>
          <small>商家卖出均价</small>
        </div>
        <div>
          <dt>有效样本</dt>
          <dd>{{ page.overview?.lastSuccess?.snapshot?.validSampleCount ?? 0 }} 条</dd>
          <small>{{ page.formatDate(page.overview?.lastSuccess?.snapshot?.averagedAt) }}</small>
        </div>
        <div>
          <dt>采集周期</dt>
          <dd>{{ page.intervalLabel(page.runtime?.settings.intervalMinutes) }}</dd>
          <small>下次 {{ page.formatDate(page.runtime?.settings.nextRunAt) }}</small>
        </div>
      </dl>
    </section>

    <section class="v2-exchange-receipt-rates" aria-label="订单收款汇率状态">
      <V2SectionHeading
        class="v2-exchange-receipt-rates__heading"
        title="订单收款汇率"
        help="展示订单录入当前可采用的最新汇率；过期或缺失状态不会被自动带入。"
      >
        <template #actions>
          <span>最新可用状态</span>
        </template>
      </V2SectionHeading>
      <dl>
        <div
          v-for="rate in page.receiptFxRates"
          :key="rate.currency"
          :class="{ 'is-muted': rate.status === 'missing' }"
        >
          <dt>
            <span>{{ rate.currency }}</span>
            <el-tag :type="page.receiptFxStatusType(rate.status)" size="small" effect="plain">
              {{ page.receiptFxStatusLabel(rate.status) }}
            </el-tag>
          </dt>
          <dd>{{ rate.rateToCny ? page.formatRate(rate.rateToCny) : '—' }}</dd>
          <small>
            {{ page.receiptFxSourceLabel(rate.source) }} · {{ page.receiptFxCapturedLabel(rate) }}
          </small>
        </div>
      </dl>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh, Setting, VideoPlay } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

defineProps<{
  page: ExchangeRatesPage;
}>();
</script>
