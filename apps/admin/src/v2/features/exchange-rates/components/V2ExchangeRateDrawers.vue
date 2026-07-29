<template>
  <el-drawer v-model="page.settingsVisible" title="采集设置" size="min(480px, 96vw)">
    <el-form
      label-position="left"
      label-width="132px"
      require-asterisk-position="right"
      class="v2-exchange-settings v2-horizontal-form"
    >
      <el-form-item label="自动采集">
        <el-switch v-model="page.settingsForm.autoEnabled" />
      </el-form-item>
      <el-form-item label="采集周期">
        <el-select v-model="page.settingsForm.intervalMinutes">
          <el-option
            v-for="minutes in page.runtime?.settings.allowedIntervals ?? page.defaultIntervals"
            :key="minutes"
            :label="page.intervalLabel(minutes)"
            :value="minutes"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="目标成交额（人民币）">
        <el-input
          v-model="page.settingsForm.targetAmountRmb"
          inputmode="decimal"
          maxlength="10"
          placeholder="5000"
        />
      </el-form-item>
      <el-alert
        type="info"
        title="保存后会安排一次立即采集"
        description="设置关闭时仍可由有权限的操作员点击立即采集。"
        show-icon
        :closable="false"
      />
    </el-form>
    <template #footer>
      <div class="v2-exchange-drawer-footer">
        <AppButton variant="ghost" @click="page.settingsVisible = false">取消</AppButton>
        <AppButton variant="primary" :loading="page.settingsSaving" @click="page.saveSettings">
          保存设置
        </AppButton>
      </div>
    </template>
  </el-drawer>

  <el-drawer v-model="page.runDetailVisible" title="自动采集批次" size="min(880px, 98vw)">
    <V2AsyncRegion
      variant="section"
      skeleton="detail"
      :loading="page.detailLoading"
      :resolved="Boolean(page.runDetail)"
      :error="page.detailError"
      loading-title="正在加载采集证据"
      refreshing-title="正在更新采集证据"
      error-title="采集详情加载失败"
      @retry="page.retryRunDetail"
    >
      <section v-if="page.runDetail" class="v2-exchange-detail">
        <dl class="v2-exchange-detail-summary">
          <div>
            <dt>批次编号</dt>
            <dd>{{ page.runDetail.id }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ page.runStatusLabel(page.runDetail.status) }}</dd>
          </div>
          <div>
            <dt>目标成交额</dt>
            <dd>¥{{ page.formatAmount(page.runDetail.targetAmountRmb) }}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{{ page.formatDate(page.runDetail.startedAt) }}</dd>
          </div>
          <div>
            <dt>综合买入</dt>
            <dd>
              {{ page.formatRate(page.runDetail.snapshot?.combinedMerchantBuyAverageRateToRmb) }}
            </dd>
          </div>
          <div>
            <dt>综合卖出</dt>
            <dd>
              {{ page.formatRate(page.runDetail.snapshot?.combinedMerchantSellAverageRateToRmb) }}
            </dd>
          </div>
          <div class="v2-exchange-detail__primary">
            <dt>中间价</dt>
            <dd>{{ page.formatRate(page.runDetail.snapshot?.midRateToRmb) }}</dd>
          </div>
          <div v-if="page.runDetail.error" class="v2-exchange-detail__wide">
            <dt>失败原因</dt>
            <dd>{{ page.failureLabel(page.runDetail) }}</dd>
          </div>
          <div v-if="page.runDetail.error" class="v2-exchange-detail__wide">
            <dt>技术代码</dt>
            <dd>
              <code>{{ page.runDetail.error.code }}</code>
            </dd>
          </div>
        </dl>
        <section
          v-for="provider in page.runDetail.providerSnapshots"
          :key="provider.id"
          class="v2-exchange-provider"
        >
          <header>
            <div>
              <strong
                >{{ page.providerLabel(provider.provider) }} ·
                {{ page.sideLabel(provider.side) }}</strong
              >
              <a :href="provider.sourceUrl" target="_blank" rel="noreferrer">官方来源</a>
            </div>
            <span>{{ provider.counts.valid }} 条有效 / {{ provider.counts.received }} 条收到</span>
          </header>
          <dl>
            <div>
              <dt>平台平均</dt>
              <dd>{{ page.formatRate(provider.averageRateToRmb) }}</dd>
            </div>
            <div>
              <dt>中位价</dt>
              <dd>{{ page.formatRate(provider.medianRateToRmb) }}</dd>
            </div>
            <div>
              <dt>最低 / 最高</dt>
              <dd>
                {{ page.formatRate(provider.lowestValidRateToRmb) }} /
                {{ page.formatRate(provider.highestValidRateToRmb) }}
              </dd>
            </div>
          </dl>
          <div class="v2-exchange-samples">
            <el-table
              scrollbar-always-on
              show-overflow-tooltip
              :data="provider.validSamples"
              size="small"
              row-key="sourceAdId"
            >
              <el-table-column prop="sourceAdId" label="公开广告编号" min-width="180" />
              <el-table-column label="价格" width="92">
                <template #default="{ row }">{{ page.formatRate(row.priceToRmb) }}</template>
              </el-table-column>
              <el-table-column label="最低成交额" min-width="120">
                <template #default="{ row }">¥{{ page.formatAmount(row.minAmountRmb) }}</template>
              </el-table-column>
              <el-table-column label="最高成交额" min-width="120">
                <template #default="{ row }">¥{{ page.formatAmount(row.maxAmountRmb) }}</template>
              </el-table-column>
              <el-table-column prop="completedOrderCount" label="完成订单" width="96" />
              <el-table-column label="完成率" width="88">
                <template #default="{ row }">{{ page.formatPercent(row.completionRate) }}</template>
              </el-table-column>
            </el-table>
          </div>
        </section>
      </section>
    </V2AsyncRegion>
  </el-drawer>

  <el-drawer v-model="page.manualCreateVisible" title="录入人工汇率" size="min(700px, 96vw)">
    <el-form
      label-position="left"
      label-width="92px"
      require-asterisk-position="right"
      class="v2-exchange-form v2-horizontal-form"
    >
      <section class="v2-exchange-form__group">
        <h2>Binance</h2>
        <div class="v2-exchange-form__grid">
          <el-form-item label="商家买入价"
            ><el-input v-model="page.manualForm.binanceMerchantBuyRateToRmb" inputmode="decimal"
          /></el-form-item>
          <el-form-item label="商家卖出价"
            ><el-input v-model="page.manualForm.binanceMerchantSellRateToRmb" inputmode="decimal"
          /></el-form-item>
        </div>
      </section>
      <section class="v2-exchange-form__group">
        <h2>OKX</h2>
        <div class="v2-exchange-form__grid">
          <el-form-item label="商家买入价"
            ><el-input v-model="page.manualForm.okxMerchantBuyRateToRmb" inputmode="decimal"
          /></el-form-item>
          <el-form-item label="商家卖出价"
            ><el-input v-model="page.manualForm.okxMerchantSellRateToRmb" inputmode="decimal"
          /></el-form-item>
        </div>
      </section>
      <el-form-item label="记录时间">
        <el-date-picker v-model="page.manualForm.recordedAt" type="datetime" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input
          v-model="page.manualForm.remark"
          type="textarea"
          :rows="3"
          maxlength="2000"
          show-word-limit
        />
      </el-form-item>
      <el-alert
        type="warning"
        title="人工记录只进入人工历史，不会覆盖自动采集汇率"
        :description="`中间价预览：${page.manualPreview}`"
        show-icon
        :closable="false"
      />
    </el-form>
    <template #footer>
      <div class="v2-exchange-drawer-footer">
        <AppButton variant="ghost" @click="page.manualCreateVisible = false">取消</AppButton>
        <AppButton variant="primary" :loading="page.manualCreating" @click="page.createManualEntry"
          >确认录入</AppButton
        >
      </div>
    </template>
  </el-drawer>

  <el-drawer v-model="page.manualDetailVisible" title="人工汇率详情" size="min(560px, 96vw)">
    <section v-if="page.manualDetail" class="v2-exchange-detail">
      <dl class="v2-exchange-detail-summary">
        <div>
          <dt>记录时间</dt>
          <dd>{{ page.formatDate(page.manualDetail.recordedAt) }}</dd>
        </div>
        <div>
          <dt>操作人</dt>
          <dd>{{ page.operatorName(page.manualDetail) }}</dd>
        </div>
        <div>
          <dt>Binance 买入 / 卖出</dt>
          <dd>
            {{ page.formatRate(page.manualDetail.binanceMerchantBuyRateToRmb) }} /
            {{ page.formatRate(page.manualDetail.binanceMerchantSellRateToRmb) }}
          </dd>
        </div>
        <div>
          <dt>OKX 买入 / 卖出</dt>
          <dd>
            {{ page.formatRate(page.manualDetail.okxMerchantBuyRateToRmb) }} /
            {{ page.formatRate(page.manualDetail.okxMerchantSellRateToRmb) }}
          </dd>
        </div>
        <div class="v2-exchange-detail__primary">
          <dt>中间价</dt>
          <dd>{{ page.formatRate(page.manualDetail.midRateToRmb) }}</dd>
        </div>
        <div class="v2-exchange-detail__wide">
          <dt>备注</dt>
          <dd>{{ page.manualDetail.remark || '-' }}</dd>
        </div>
      </dl>
    </section>
  </el-drawer>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

defineProps<{
  page: ExchangeRatesPage;
}>();
</script>
