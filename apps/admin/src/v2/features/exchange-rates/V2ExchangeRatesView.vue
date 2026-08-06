<template>
  <section class="v2-exchange-page">
    <section class="v2-page-actionbar" aria-label="汇率操作">
      <div class="v2-exchange-header-actions">
        <AppButton v-if="page.canCollect" :loading="page.collecting" @click="page.collectNow">
          <el-icon><VideoPlay /></el-icon>
          立即采集
        </AppButton>
        <AppButton v-if="page.canManage" icon-only title="采集设置" @click="page.openSettings">
          <el-icon><Setting /></el-icon>
        </AppButton>
        <AppButton
          v-if="page.canCreate"
          icon-only
          title="录入人工汇率"
          @click="page.openManualCreate"
        >
          <el-icon><Plus /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.headerLoading" @click="page.loadAll">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      variant="section"
      skeleton="metrics"
      :loading="page.headerLoading"
      :resolved="Boolean(page.overview && page.runtime)"
      :error="page.headerError"
      loading-title="正在加载汇率状态"
      refreshing-title="正在更新汇率状态"
      error-title="汇率状态加载失败"
      @retry="page.loadHeader"
    >
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
        <div
          class="v2-exchange-rate-primary"
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
        <dl class="v2-exchange-rate-pairs">
          <div>
            <dt>综合买入</dt>
            <dd>
              {{
                page.formatRate(
                  page.overview?.lastSuccess?.snapshot?.combinedMerchantBuyAverageRateToRmb
                )
              }}
            </dd>
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
          </div>
          <div>
            <dt>有效样本</dt>
            <dd>{{ page.overview?.lastSuccess?.snapshot?.validSampleCount ?? 0 }} 条</dd>
          </div>
          <div>
            <dt>采集时间</dt>
            <dd>{{ page.formatDate(page.overview?.lastSuccess?.snapshot?.averagedAt) }}</dd>
          </div>
        </dl>
        <dl class="v2-exchange-runtime">
          <div>
            <dt>自动采集</dt>
            <dd>
              <el-tag
                :type="page.runtime?.settings.autoEnabled ? 'success' : 'info'"
                size="small"
                effect="plain"
              >
                {{ page.runtime?.settings.autoEnabled ? '已开启' : '已关闭' }}
              </el-tag>
            </dd>
          </div>
          <div>
            <dt>成交档位</dt>
            <dd>¥{{ page.formatAmount(page.runtime?.settings.targetAmountRmb) }}</dd>
          </div>
          <div>
            <dt>采集周期</dt>
            <dd>{{ page.intervalLabel(page.runtime?.settings.intervalMinutes) }}</dd>
          </div>
          <div>
            <dt>下次执行</dt>
            <dd>{{ page.formatDate(page.runtime?.settings.nextRunAt) }}</dd>
          </div>
          <div>
            <dt>数据保留</dt>
            <dd>最近 {{ page.runtime?.retention.days ?? 30 }} 天</dd>
          </div>
        </dl>
        <section class="v2-exchange-receipt-rates" aria-label="订单收款汇率状态">
          <header>
            <span>订单收款汇率</span>
            <strong>最新可用状态</strong>
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
              <small>
                {{ page.receiptFxSourceLabel(rate.source) }} ·
                {{ page.receiptFxCapturedLabel(rate) }}
              </small>
            </div>
          </dl>
        </section>
      </section>
    </V2AsyncRegion>

    <V2ExchangeRateTabs :page="page" />
    <V2ExchangeRateDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Plus, Refresh, Setting, VideoPlay } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ExchangeRateDrawers from './components/V2ExchangeRateDrawers.vue';
import V2ExchangeRateTabs from './components/V2ExchangeRateTabs.vue';
import { useExchangeRatesPage } from './useExchangeRatesPage';
import '@/v2/styles/records.css';
import '@/v2/styles/exchange-rates.css';

const page = reactive(useExchangeRatesPage());
</script>
