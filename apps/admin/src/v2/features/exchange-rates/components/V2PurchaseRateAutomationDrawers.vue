<template>
  <V2FormDrawer
    v-model="automation.settingsVisible"
    title="自动采集设置"
    eyebrow="人民币收购报价"
    description="配置每小时自动采集、过期提醒和异常波动阈值"
    size="min(600px, 96vw)"
    confirm-text="保存设置"
    :confirm-loading="automation.settingsSaving"
    :dirty="settingsDirty"
    @confirm="automation.saveSettings"
  >
    <el-form
      :model="automation.settingsForm"
      label-position="left"
      label-width="150px"
      require-asterisk-position="right"
      class="v2-horizontal-form"
    >
      <V2PanelSection heading-id="purchase-rate-schedule" title="采集计划" step="01">
        <el-form-item label="自动采集">
          <el-switch v-model="automation.settingsForm.autoEnabled" />
        </el-form-item>
        <el-form-item label="执行时间">
          <el-input model-value="每小时第 5 分钟" disabled />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="purchase-rate-safety" title="安全阈值" step="02">
        <el-form-item label="过期提醒（分钟）" required>
          <el-input-number
            v-model="automation.settingsForm.staleMinutes"
            :min="automation.runtime?.settings.allowedStaleMinutes.min ?? 30"
            :max="automation.runtime?.settings.allowedStaleMinutes.max ?? 1440"
            :step="30"
            step-strictly
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="异常波动阈值" required>
          <el-input
            v-model="automation.settingsForm.abnormalChangePercent"
            inputmode="decimal"
            maxlength="12"
          >
            <template #append>%</template>
          </el-input>
        </el-form-item>
        <el-alert
          type="info"
          title="异常批次不会自动发布"
          description="任一已启用币种超过阈值时，整批候选报价等待管理员确认；原有效报价继续保留。"
          show-icon
          :closable="false"
        />
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="automation.bulkVisible"
    title="批量设置收购比例"
    eyebrow="批量配置"
    description="对选中币种应用同一比例，并使用各自最后有效市场汇率重新计算"
    size="min(640px, 96vw)"
    confirm-text="确认批量更新"
    :confirm-loading="automation.bulkSaving"
    :dirty="bulkDirty"
    @confirm="automation.saveBulk"
  >
    <el-form
      :model="automation.bulkForm"
      label-position="left"
      label-width="130px"
      require-asterisk-position="right"
      class="v2-horizontal-form"
    >
      <el-form-item label="目标币种" required>
        <el-select
          v-model="automation.bulkForm.currencyCodes"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          placeholder="请选择币种"
        >
          <el-option
            v-for="quote in page.purchaseQuotes"
            :key="quote.code"
            :label="`${quote.displayName || quote.nameCn}（${quote.code}）`"
            :value="quote.code"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="统一收购比例" required>
        <el-input
          v-model="automation.bulkForm.purchaseRatioPercent"
          inputmode="decimal"
          placeholder="例如 70"
          maxlength="12"
        >
          <template #append>%</template>
        </el-input>
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <el-drawer v-model="automation.historyVisible" title="收购汇率与报价历史" size="min(960px, 98vw)">
    <section class="v2-purchase-history">
      <V2SectionHeading title="采集批次" help="成功、失败、待审核与驳回均保留运行记录。" />
      <V2AsyncRegion
        variant="section"
        skeleton="cards"
        :phase="automation.automationQuery.phase"
        :previous-data="automation.automationQuery.isParameterTransition"
        :error="automation.automationQuery.error ? '采集批次加载失败' : ''"
        loading-title="正在加载采集批次"
        refreshing-title="正在更新采集批次"
        error-title="采集批次加载失败"
        @retry="automation.automationQuery.refresh"
      >
        <div v-if="automation.runs.length" class="v2-purchase-run-list">
          <button
            v-for="run in automation.runs"
            :key="run.id"
            type="button"
            @click="automation.openRun(run)"
          >
            <span>
              <strong>{{ runStatusLabel(run.status) }}</strong>
              <small
                >{{ page.formatDate(run.startedAt) }} · {{ triggerLabel(run.triggerType) }}</small
              >
            </span>
            <span>
              {{ run.snapshotCount }} 个报价
              <small v-if="run.abnormalCurrencyCodes.length">
                异常：{{ run.abnormalCurrencyCodes.join('、') }}
              </small>
            </span>
          </button>
        </div>
        <div v-else class="v2-records-empty">
          <strong>暂无采集批次</strong>
          <span>首次自动或手动刷新后会显示运行记录</span>
        </div>
        <el-pagination
          v-if="(automation.automationQuery.data?.runs.total ?? 0) > automation.runPageSize"
          v-pagination-label
          :current-page="automation.runPage"
          :page-size="automation.runPageSize"
          background
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next"
          :total="automation.automationQuery.data?.runs.total ?? 0"
          @current-change="automation.runPage = $event"
          @size-change="automation.runPageSize = $event"
        />
      </V2AsyncRegion>

      <V2SectionHeading title="报价快照" help="手工调整和自动采集都会形成不可变快照。" />
      <div class="v2-purchase-history__filters">
        <el-select
          v-model="automation.historyCurrencyCode"
          clearable
          filterable
          placeholder="全部币种"
          aria-label="筛选报价历史币种"
        >
          <el-option
            v-for="quote in page.purchaseQuotes"
            :key="quote.code"
            :label="`${quote.displayName || quote.nameCn}（${quote.code}）`"
            :value="quote.code"
          />
        </el-select>
      </div>
      <V2AsyncRegion
        variant="section"
        skeleton="cards"
        :phase="automation.historyQuery.phase"
        :previous-data="automation.historyQuery.isParameterTransition"
        :error="automation.historyQuery.error ? '报价历史加载失败' : ''"
        loading-title="正在加载报价历史"
        refreshing-title="正在更新报价历史"
        error-title="报价历史加载失败"
        @retry="automation.historyQuery.refresh"
      >
        <div v-if="automation.historyQuery.data?.items.length" class="v2-purchase-snapshot-list">
          <article v-for="item in automation.historyQuery.data.items" :key="item.id">
            <strong>{{ item.currencyName }}（{{ item.currencyCode }}）</strong>
            <span>市场价 ¥{{ page.formatRate(item.marketRateCnyPerUnit) }}</span>
            <span>收购价 ¥{{ page.formatRate(item.purchaseRateDisplay) }}</span>
            <small>
              {{ sourceLabel(item.marketRateSource) }} ·
              {{ page.formatDate(item.marketRateCapturedAt) }}
            </small>
          </article>
        </div>
        <div v-else class="v2-records-empty">
          <strong>暂无报价快照</strong>
          <span>请调整币种筛选或先刷新汇率</span>
        </div>
        <el-pagination
          v-if="(automation.historyQuery.data?.total ?? 0) > automation.historyPageSize"
          v-pagination-label
          :current-page="automation.historyPage"
          :page-size="automation.historyPageSize"
          background
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next"
          :total="automation.historyQuery.data?.total ?? 0"
          @current-change="automation.historyPage = $event"
          @size-change="automation.historyPageSize = $event"
        />
      </V2AsyncRegion>
    </section>
  </el-drawer>

  <el-drawer v-model="automation.detailVisible" title="收购汇率采集批次" size="min(820px, 98vw)">
    <V2AsyncRegion
      variant="section"
      skeleton="detail"
      :phase="automation.detailQuery.phase"
      :error="automation.detailQuery.error ? '采集批次详情加载失败' : ''"
      loading-title="正在加载批次详情"
      refreshing-title="正在更新批次详情"
      error-title="批次详情加载失败"
      @retry="automation.detailQuery.refresh"
    >
      <section v-if="automation.detailQuery.data" class="v2-purchase-run-detail">
        <V2DetailSummary
          heading-id="purchase-rate-run-summary"
          eyebrow="收购汇率采集"
          :title="automation.detailQuery.data.id"
          :description="`${runStatusLabel(automation.detailQuery.data.status)} · ${page.formatDate(automation.detailQuery.data.startedAt)}`"
          :metrics="[
            {
              label: '发布报价',
              value: String(automation.detailQuery.data.snapshotCount)
            },
            {
              label: '请求次数',
              value: String(automation.detailQuery.data.attemptCount)
            }
          ]"
          :facts="[
            {
              label: '供应商时间',
              value: page.formatDate(automation.detailQuery.data.providerUpdatedAt)
            },
            {
              label: '异常币种',
              value: automation.detailQuery.data.abnormalCurrencyCodes.join('、') || '无'
            },
            {
              label: '失败原因',
              value: automation.detailQuery.data.error?.message || '—'
            }
          ]"
        />
        <div
          v-if="automation.detailQuery.data.candidateQuotes?.length"
          class="v2-purchase-candidate-list"
        >
          <article
            v-for="candidate in automation.detailQuery.data.candidateQuotes"
            :key="candidate.currencyCode"
            :class="{ 'is-abnormal': candidate.abnormal }"
          >
            <strong>{{ candidate.currencyCode }}</strong>
            <span>候选市场价 ¥{{ page.formatRate(candidate.marketRateCnyPerUnit) }}</span>
            <span>候选收购价 ¥{{ page.formatRate(candidate.purchaseRateDisplay) }}</span>
            <small>波动 {{ page.formatPercent(candidate.changeRate) }}</small>
          </article>
        </div>
        <el-form
          v-if="automation.detailQuery.data.status === 'pending_review' && page.canManage"
          label-position="left"
          label-width="100px"
          require-asterisk-position="right"
          class="v2-horizontal-form"
        >
          <el-form-item label="审核说明">
            <el-input
              v-model="automation.reviewRemark"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="可填写确认或驳回原因"
            />
          </el-form-item>
        </el-form>
      </section>
    </V2AsyncRegion>
    <template
      v-if="automation.detailQuery.data?.status === 'pending_review' && page.canManage"
      #footer
    >
      <div class="v2-purchase-review-actions">
        <AppButton
          variant="danger"
          :loading="automation.reviewSubmitting"
          @click="automation.review(false)"
        >
          驳回并保留原报价
        </AppButton>
        <AppButton
          variant="primary"
          :loading="automation.reviewSubmitting"
          @click="automation.review(true)"
        >
          确认并发布候选报价
        </AppButton>
      </div>
    </template>
  </el-drawer>

  <el-drawer v-model="automation.textVisible" title="生成可复制报价" size="min(720px, 98vw)">
    <section class="v2-purchase-text">
      <el-radio-group v-model="automation.textFormat" aria-label="报价文本格式">
        <el-radio-button value="wechat">微信排版</el-radio-button>
        <el-radio-button value="monospace">等宽排版</el-radio-button>
        <el-radio-button value="plain">纯文本</el-radio-button>
      </el-radio-group>
      <V2AsyncRegion
        variant="section"
        skeleton="detail"
        :phase="automation.textQuery.phase"
        :previous-data="automation.textQuery.isParameterTransition"
        :error="automation.textQuery.error ? '报价文本生成失败' : ''"
        loading-title="正在生成报价文本"
        refreshing-title="正在切换报价格式"
        error-title="报价文本生成失败"
        @retry="automation.textQuery.refresh"
      >
        <el-alert
          v-if="automation.textQuery.data?.containsStaleQuotes"
          type="warning"
          title="文本中包含已过期报价"
          description="建议先立即刷新汇率，再复制发送给客户。"
          show-icon
          :closable="false"
        />
        <el-input
          :model-value="automation.textQuery.data?.text || ''"
          type="textarea"
          :rows="20"
          readonly
          resize="vertical"
          aria-label="生成的收购报价文本"
        />
      </V2AsyncRegion>
    </section>
    <template #footer>
      <AppButton
        variant="primary"
        :disabled="!automation.textQuery.data?.text"
        @click="automation.copyText"
      >
        一键复制
      </AppButton>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const props = defineProps<{ page: ExchangeRatesPage }>();
const automation = props.page.purchaseAutomation;
const { dirty: settingsDirty } = useV2FormSnapshot(
  () => automation.settingsVisible,
  () => automation.settingsForm
);
const { dirty: bulkDirty } = useV2FormSnapshot(
  () => automation.bulkVisible,
  () => automation.bulkForm
);

function runStatusLabel(status?: string) {
  if (status === 'running') return '运行中';
  if (status === 'success') return '成功发布';
  if (status === 'failed') return '采集失败';
  if (status === 'pending_review') return '等待审核';
  if (status === 'rejected') return '已驳回';
  return '暂无记录';
}

function triggerLabel(trigger: string) {
  if (trigger === 'manual') return '手动刷新';
  if (trigger === 'scheduled') return '定时采集';
  return '系统触发';
}

function sourceLabel(source: string) {
  return source === 'currencyapi' ? 'CurrencyAPI 自动采集' : '管理员手工录入';
}
</script>
