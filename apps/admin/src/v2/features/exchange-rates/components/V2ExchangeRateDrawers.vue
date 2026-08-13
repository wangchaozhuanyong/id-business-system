<template>
  <V2FormDrawer
    v-model="page.settingsVisible"
    title="采集设置"
    eyebrow="自动汇率"
    description="配置采集周期、目标成交额和历史保留范围"
    size="min(520px, 96vw)"
    confirm-text="保存设置"
    :confirm-loading="page.settingsSaving"
    :confirm-disabled-reason="settingsDisabledReason"
    :dirty="settingsDirty"
    @confirm="saveSettings"
  >
    <el-form
      ref="settingsFormRef"
      :model="page.settingsForm"
      :rules="settingsRules"
      label-position="left"
      label-width="132px"
      require-asterisk-position="right"
      class="v2-exchange-settings v2-horizontal-form"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <V2PanelSection heading-id="exchange-settings-schedule" title="采集计划" step="01">
        <el-form-item label="自动采集">
          <el-switch v-model="page.settingsForm.autoEnabled" />
        </el-form-item>
        <el-form-item label="采集周期" prop="intervalMinutes">
          <el-select v-model="page.settingsForm.intervalMinutes">
            <el-option
              v-for="minutes in page.runtime?.settings.allowedIntervals ?? page.defaultIntervals"
              :key="minutes"
              :label="page.intervalLabel(minutes)"
              :value="minutes"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标成交额" prop="targetAmountRmb">
          <el-input
            v-model="page.settingsForm.targetAmountRmb"
            inputmode="decimal"
            maxlength="10"
            placeholder="5000"
          />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="exchange-settings-retention" title="数据保留" step="02">
        <el-form-item label="保留天数" prop="retentionDays">
          <el-input-number
            v-model="page.settingsForm.retentionDays"
            :min="page.runtime?.settings.allowedRetentionDays.min ?? 7"
            :max="page.runtime?.settings.allowedRetentionDays.max ?? 3650"
            :step="1"
            step-strictly
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-alert
          type="info"
          title="保存后会安排一次立即采集"
          description="CNY 固定为 1 不入库；MYR、USD、USDT 会按采集周期形成自动快照，并按保留天数清理未引用记录。"
          show-icon
          :closable="false"
        />
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

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
        <V2DetailSummary
          heading-id="exchange-run-summary"
          eyebrow="自动采集批次"
          :title="page.runDetail.id"
          :description="`${page.runStatusLabel(page.runDetail.status)} · ${page.formatDate(page.runDetail.startedAt)}`"
          :metrics="[
            {
              label: '中间价',
              value: page.formatRate(page.runDetail.snapshot?.midRateToRmb)
            },
            {
              label: '目标成交额',
              value: `¥${page.formatAmount(page.runDetail.targetAmountRmb)}`
            }
          ]"
          :facts="[
            {
              label: '综合买入',
              value: page.formatRate(page.runDetail.snapshot?.combinedMerchantBuyAverageRateToRmb)
            },
            {
              label: '综合卖出',
              value: page.formatRate(page.runDetail.snapshot?.combinedMerchantSellAverageRateToRmb)
            },
            {
              label: '失败原因',
              value: page.runDetail.error ? page.failureLabel(page.runDetail) : '—'
            }
          ]"
        />
        <dl v-if="page.runDetail.error" class="v2-exchange-detail-summary">
          <div class="v2-exchange-detail__wide">
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
            <V2Table
              :schema="v2TableSchemas.exchangeRates.offers"
              scrollbar-always-on
              show-overflow-tooltip
              :data="provider.validSamples"
              size="small"
            >
              <V2TableColumn
                :definition="v2TableSchemas.exchangeRates.offers.columns[0]"
                prop="sourceAdId"
              />
              <V2TableColumn :definition="v2TableSchemas.exchangeRates.offers.columns[1]">
                <template #default="{ row }">{{ page.formatRate(row.priceToRmb) }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.exchangeRates.offers.columns[2]">
                <template #default="{ row }">¥{{ page.formatAmount(row.minAmountRmb) }}</template>
              </V2TableColumn>
              <V2TableColumn :definition="v2TableSchemas.exchangeRates.offers.columns[3]">
                <template #default="{ row }">¥{{ page.formatAmount(row.maxAmountRmb) }}</template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.exchangeRates.offers.columns[4]"
                prop="completedOrderCount"
              />
              <V2TableColumn :definition="v2TableSchemas.exchangeRates.offers.columns[5]">
                <template #default="{ row }">{{ page.formatPercent(row.completionRate) }}</template>
              </V2TableColumn>
            </V2Table>
          </div>
        </section>
      </section>
    </V2AsyncRegion>
  </el-drawer>

  <V2FormDrawer
    v-model="page.manualCreateVisible"
    title="录入人工汇率"
    eyebrow="人工凭证"
    description="记录汇率数值、证据时间和来源说明"
    size="min(700px, 96vw)"
    confirm-text="确认录入"
    :confirm-loading="page.manualCreating"
    :confirm-disabled-reason="manualDisabledReason"
    :dirty="manualDirty"
    @confirm="createManualEntry"
  >
    <el-form
      ref="manualFormRef"
      :model="page.manualForm"
      :rules="manualRules"
      label-position="left"
      label-width="92px"
      require-asterisk-position="right"
      class="v2-exchange-form v2-horizontal-form"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <V2PanelSection heading-id="exchange-manual-rate" title="汇率凭证" step="01">
        <el-form-item label="币种" prop="currency">
          <el-select v-model="page.manualForm.currency">
            <el-option
              v-for="currency in page.trackedCurrencies"
              :key="currency"
              :label="page.currencyLabel(currency)"
              :value="currency"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="兑人民币汇率" prop="rateToCny">
          <el-input
            v-model="page.manualForm.rateToCny"
            inputmode="decimal"
            placeholder="1.65000000"
          />
        </el-form-item>
        <el-form-item label="记录时间" prop="recordedAt">
          <el-date-picker
            v-model="page.manualForm.recordedAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            style="width: 100%"
          />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="exchange-manual-evidence" title="来源与原因" step="02">
        <el-form-item label="来源说明" prop="sourceReference">
          <el-input
            v-model="page.manualForm.sourceReference"
            maxlength="500"
            placeholder="银行成交单、平台截图或人工核对来源"
          />
        </el-form-item>
        <el-form-item label="录入原因" prop="reason">
          <el-input
            v-model="page.manualForm.reason"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
          />
        </el-form-item>
        <el-alert
          type="warning"
          title="人工记录只进入人工历史，不会覆盖自动采集汇率"
          :description="`汇率预览：${page.manualPreview}`"
          show-icon
          :closable="false"
        />
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <el-drawer v-model="page.manualDetailVisible" title="人工汇率详情" size="min(560px, 96vw)">
    <section v-if="page.manualDetail" class="v2-exchange-detail">
      <V2DetailSummary
        heading-id="exchange-manual-summary"
        eyebrow="人工汇率"
        :title="page.currencyLabel(page.manualDetail.currency)"
        :description="page.manualDetail.sourceReference || '未填写来源说明'"
        :metrics="[
          { label: '兑人民币汇率', value: page.formatRate(page.manualDetail.rateToCny) },
          { label: '操作人', value: page.operatorName(page.manualDetail) }
        ]"
        :facts="[
          { label: '记录时间', value: page.formatDate(page.manualDetail.recordedAt) },
          { label: '录入原因', value: page.manualDetail.reason || '—' }
        ]"
      />
    </section>
  </el-drawer>
</template>

<script setup lang="ts">
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { V2_DECIMAL_PLACES, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const props = defineProps<{
  page: ExchangeRatesPage;
}>();

const settingsFormRef = ref<FormInstance>();
const manualFormRef = ref<FormInstance>();
const { dirty: settingsDirty } = useV2FormSnapshot(
  () => props.page.settingsVisible,
  () => props.page.settingsForm
);
const { dirty: manualDirty } = useV2FormSnapshot(
  () => props.page.manualCreateVisible,
  () => props.page.manualForm
);
const settingsDisabledReason = computed(() => {
  if (!props.page.canManage) return '当前账号无汇率设置权限';
  if (!props.page.runtime) return '汇率运行配置尚未加载';
  return '';
});
const manualDisabledReason = computed(() =>
  props.page.canCreate ? '' : '当前账号无人工汇率录入权限'
);
const settingsRules = computed<FormRules>(() => ({
  intervalMinutes: [
    { required: true, message: '请选择采集周期', trigger: 'change' },
    {
      validator: (_rule, value, callback) =>
        callback(
          (props.page.runtime?.settings.allowedIntervals ?? props.page.defaultIntervals).includes(
            Number(value)
          )
            ? undefined
            : new Error('请选择系统允许的采集周期')
        ),
      trigger: 'change'
    }
  ],
  targetAmountRmb: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const amount = Number(value);
        callback(
          isV2UnsignedDecimal(value, { allowZero: false }) &&
            Number.isFinite(amount) &&
            amount <= 1_000_000
            ? undefined
            : new Error(
                `目标成交额必须大于 0、不超过 1,000,000 元且最多 ${V2_DECIMAL_PLACES} 位小数`
              )
        );
      },
      trigger: 'blur'
    }
  ],
  retentionDays: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const min = props.page.runtime?.settings.allowedRetentionDays.min ?? 7;
        const max = props.page.runtime?.settings.allowedRetentionDays.max ?? 3650;
        const days = Number(value);
        callback(
          Number.isInteger(days) && days >= min && days <= max
            ? undefined
            : new Error(`数据保留天数必须是 ${min} 到 ${max} 之间的整数`)
        );
      },
      trigger: 'change'
    }
  ]
}));
const rateRule = {
  required: true,
  validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) =>
    callback(
      isV2UnsignedDecimal(value, {
        allowZero: false,
        decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
      })
        ? undefined
        : new Error(`请输入大于 0、最多 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数的汇率`)
    ),
  trigger: 'blur'
};
const manualRules: FormRules = {
  currency: [{ required: true, message: '请选择币种', trigger: 'change' }],
  rateToCny: [rateRule],
  recordedAt: [{ required: true, message: '请选择记录时间', trigger: 'change' }],
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) =>
        callback(
          String(value ?? '').trim().length >= 2
            ? undefined
            : new Error('人工汇率原因至少填写 2 个字符')
        ),
      trigger: 'blur'
    }
  ]
};

async function saveSettings() {
  if (settingsDisabledReason.value || !(await validateV2Form(settingsFormRef.value))) return;
  await props.page.saveSettings();
}

async function createManualEntry() {
  if (manualDisabledReason.value || !(await validateV2Form(manualFormRef.value))) return;
  await props.page.createManualEntry();
}
</script>
