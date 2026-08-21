<template>
  <V2FormDrawer
    v-model="page.purchaseDrawerVisible"
    :title="`${page.purchaseForm.code || '币种'}收购报价`"
    eyebrow="独立比例计算"
    description="配置该币种的市场人民币汇率、收购比例和显示规则"
    size="min(720px, 96vw)"
    confirm-text="保存并计算"
    :confirm-loading="page.purchaseSaving"
    :confirm-disabled-reason="disabledReason"
    :dirty="dirty"
    @confirm="save"
  >
    <el-form
      ref="formRef"
      :model="page.purchaseForm"
      :rules="rules"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
      class="v2-exchange-form v2-horizontal-form"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <V2PanelSection heading-id="purchase-quote-currency" title="币种与比例" step="01">
        <el-form-item label="币种代码">
          <el-input :model-value="page.purchaseForm.code" disabled />
        </el-form-item>
        <el-form-item label="币种名称" prop="nameCn">
          <el-input v-model="page.purchaseForm.nameCn" maxlength="50" />
        </el-form-item>
        <el-form-item label="客户显示名称" prop="displayName">
          <el-input
            v-model="page.purchaseForm.displayName"
            maxlength="100"
            placeholder="留空时使用币种名称"
          />
        </el-form-item>
        <el-form-item label="收购比例" prop="purchaseRatioPercent">
          <el-input
            v-model="page.purchaseForm.purchaseRatioPercent"
            inputmode="decimal"
            placeholder="70"
          >
            <template #append>%</template>
          </el-input>
        </el-form-item>
        <el-form-item label="启用状态">
          <el-switch v-model="page.purchaseForm.enabled" />
        </el-form-item>
      </V2PanelSection>

      <V2PanelSection heading-id="purchase-quote-market-rate" title="市场人民币汇率" step="02">
        <el-form-item label="手工覆盖汇率">
          <el-switch v-model="page.purchaseForm.overrideMarketRate" />
        </el-form-item>
        <el-form-item label="国际人民币汇率" prop="marketRateCnyPerUnit">
          <el-input
            v-model="page.purchaseForm.marketRateCnyPerUnit"
            inputmode="decimal"
            placeholder="例如 8.32000000"
            :disabled="!page.purchaseForm.overrideMarketRate"
          />
        </el-form-item>
        <el-form-item label="汇率时间" prop="marketRateCapturedAt">
          <el-date-picker
            v-model="page.purchaseForm.marketRateCapturedAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            style="width: 100%"
            :disabled="!page.purchaseForm.overrideMarketRate"
          />
        </el-form-item>
        <el-form-item label="汇率来源说明" prop="marketRateSourceReference">
          <el-input
            v-model="page.purchaseForm.marketRateSourceReference"
            maxlength="500"
            placeholder="银行牌价、公开市场页面或人工核对来源"
            :disabled="!page.purchaseForm.overrideMarketRate"
          />
        </el-form-item>
        <el-alert
          type="info"
          title="默认沿用最后有效的自动汇率"
          description="仅在确需人工修正时开启手工覆盖；覆盖操作会形成新的不可变快照和审计记录。"
          show-icon
          :closable="false"
        />
      </V2PanelSection>

      <V2PanelSection heading-id="purchase-quote-display" title="显示与舍入" step="03">
        <el-form-item label="显示单位" prop="quoteUnit">
          <el-input v-model="page.purchaseForm.quoteUnit" inputmode="decimal" placeholder="1" />
        </el-form-item>
        <el-form-item label="保留小数位" prop="decimalPlaces">
          <el-input-number
            v-model="page.purchaseForm.decimalPlaces"
            :min="0"
            :max="V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES"
            :step="1"
            step-strictly
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="舍入方式" prop="roundingMode">
          <el-select v-model="page.purchaseForm.roundingMode">
            <el-option label="向下截断" value="ROUND_DOWN" />
            <el-option label="四舍五入" value="ROUND_HALF_UP" />
            <el-option label="向上取整" value="ROUND_UP" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序数字" prop="sortOrder">
          <el-input-number
            v-model="page.purchaseForm.sortOrder"
            :min="0"
            :max="1000000"
            :step="1"
            step-strictly
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
      </V2PanelSection>

      <section class="v2-purchase-preview" aria-live="polite">
        <span>实时计算预览</span>
        <strong v-if="page.purchasePreview">
          {{ page.purchaseForm.quoteUnit }} {{ page.purchaseForm.code }} = ¥{{
            page.purchasePreview.purchaseRateFormatted
          }}
        </strong>
        <strong v-else>录入有效市场汇率后显示</strong>
        <small>
          市场汇率 × {{ page.purchaseForm.purchaseRatioPercent || '—' }}% × 显示单位，按
          {{ page.purchaseRoundingLabel(page.purchaseForm.roundingMode) }}处理
        </small>
      </section>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const props = defineProps<{
  page: ExchangeRatesPage;
}>();

const formRef = ref<FormInstance>();
const { dirty } = useV2FormSnapshot(
  () => props.page.purchaseDrawerVisible,
  () => props.page.purchaseForm
);
const disabledReason = computed(() => (props.page.canManage ? '' : '当前账号无收购报价管理权限'));
const decimalRule = (label: string, maximum?: number) => ({
  validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
    const valid = isV2UnsignedDecimal(value, {
      allowZero: false,
      decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
    });
    callback(
      valid && (maximum === undefined || Number(value) <= maximum)
        ? undefined
        : new Error(
            `${label}必须大于 0${maximum === undefined ? '' : `且不超过 ${maximum}`}，最多保留 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数`
          )
    );
  },
  trigger: 'blur'
});
const rules = computed<FormRules>(() => ({
  nameCn: [{ required: true, message: '请输入币种名称', trigger: 'blur' }],
  purchaseRatioPercent: [{ required: true, ...decimalRule('收购比例', 100) }],
  quoteUnit: [{ required: true, ...decimalRule('显示单位', 1000000) }],
  marketRateCnyPerUnit: [
    {
      validator: (_rule, value, callback) => {
        if (!props.page.purchaseForm.overrideMarketRate || !String(value ?? '').trim()) {
          return callback();
        }
        return decimalRule('国际人民币汇率').validator(_rule, value, callback);
      },
      trigger: 'blur'
    }
  ],
  marketRateCapturedAt: [
    {
      validator: (_rule, value, callback) =>
        callback(
          props.page.purchaseForm.overrideMarketRate &&
            props.page.purchaseForm.marketRateCnyPerUnit.trim() &&
            !value
            ? new Error('录入市场汇率时必须选择汇率时间')
            : undefined
        ),
      trigger: 'change'
    }
  ],
  marketRateSourceReference: [
    {
      validator: (_rule, value, callback) =>
        callback(
          props.page.purchaseForm.overrideMarketRate &&
            props.page.purchaseForm.marketRateCnyPerUnit.trim() &&
            !String(value ?? '').trim()
            ? new Error('手工覆盖汇率必须填写来源说明')
            : undefined
        ),
      trigger: 'blur'
    }
  ],
  decimalPlaces: [
    {
      validator: (_rule, value, callback) =>
        callback(
          Number.isInteger(Number(value)) &&
            Number(value) >= 0 &&
            Number(value) <= V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
            ? undefined
            : new Error(`保留小数位必须是 0 到 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 之间的整数`)
        ),
      trigger: 'change'
    }
  ],
  roundingMode: [{ required: true, message: '请选择舍入方式', trigger: 'change' }],
  sortOrder: [
    {
      validator: (_rule, value, callback) =>
        callback(
          Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000
            ? undefined
            : new Error('排序必须是 0 到 1000000 之间的整数')
        ),
      trigger: 'change'
    }
  ]
}));

async function save() {
  if (disabledReason.value || !(await validateV2Form(formRef.value))) return;
  await props.page.savePurchaseQuote();
}
</script>
