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

    <section class="v2-exchange-overview" aria-label="当前可用汇率">
      <header class="v2-exchange-overview__header">
        <div class="v2-exchange-overview__intro">
          <span class="v2-exchange-overview__eyebrow">汇率状态</span>
          <div class="v2-exchange-overview__title-row">
            <h2>当前可用汇率</h2>
            <el-tag
              :type="page.runtime?.settings.autoEnabled ? 'success' : 'info'"
              size="small"
              effect="plain"
            >
              自动采集{{ page.runtime?.settings.autoEnabled ? '已开启' : '已关闭' }}
            </el-tag>
          </div>
          <p>集中查看当前业务可用值；采集证据与历史变动在下方记录中查询。</p>
        </div>

        <div class="v2-exchange-overview__actions" aria-label="自动汇率操作">
          <AppButton v-if="page.canCollect" :loading="page.collecting" @click="page.collectNow">
            <el-icon><VideoPlay /></el-icon>
            立即采集
          </AppButton>
          <AppButton v-if="page.canManage" variant="ghost" @click="page.openSettings">
            <el-icon><Setting /></el-icon>
            采集设置
          </AppButton>
        </div>
      </header>

      <div class="v2-exchange-overview__body">
        <section
          class="v2-exchange-overview__primary"
          :class="{ 'is-stale': page.overview?.lastSuccess?.stale }"
          aria-label="USDT 当前汇率"
        >
          <span>USDT 兑人民币</span>
          <strong>
            <small>¥</small
            >{{ page.formatRate(page.overview?.lastSuccess?.snapshot?.midRateToRmb) }}
          </strong>
          <p>
            {{ page.overview?.lastSuccess?.snapshot?.validSampleCount ?? 0 }} 条有效样本
            <span aria-hidden="true">·</span>
            {{ page.formatDate(page.overview?.lastSuccess?.snapshot?.averagedAt) }}
          </p>
          <div class="v2-exchange-overview__schedule">
            <span>每 {{ page.intervalLabel(page.runtime?.settings.intervalMinutes) }}采集</span>
            <span>下次 {{ page.formatDate(page.runtime?.settings.nextRunAt) }}</span>
          </div>
        </section>

        <section class="v2-exchange-receipt-rates" aria-label="其他订单收款汇率">
          <header>
            <div>
              <h3>其他收款汇率</h3>
              <p>CNY 固定为 1；仅有效外币汇率会自动带入订单。</p>
            </div>
            <span>1 单位外币兑人民币</span>
          </header>
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
              <small>{{ page.receiptFxSourceLabel(rate.source) }}</small>
            </div>
          </dl>
        </section>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Setting, VideoPlay } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

defineProps<{
  page: ExchangeRatesPage;
}>();
</script>
