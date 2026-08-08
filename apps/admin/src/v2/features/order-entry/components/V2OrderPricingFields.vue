<template>
  <el-form-item label="推荐价格">
    <div class="v2-order-entry-recommendation">
      <div>
        <strong>
          {{
            suggestedReceipt.originalAmount
              ? formatReceiptAmount(suggestedReceipt.originalAmount)
              : suggestedReceipt.cnyAmount
                ? `人民币基准 ¥${formatDecimal(suggestedReceipt.cnyAmount)}`
                : '-'
          }}
        </strong>
        <small v-if="suggestedReceipt.error">{{ suggestedReceipt.error }}</small>
        <small
          v-else-if="
            form.receivedCurrency !== 'CNY' &&
            suggestedReceipt.cnyAmount &&
            suggestedReceipt.equivalentCnyAmount
          "
        >
          按人民币目标价与汇率
          {{
            form.receivedFxMode === 'manual' ? form.receivedFxRateToCny : form.automaticFxRateToCny
          }}
          精确换算；推荐整数折合 ¥{{ formatDecimal(suggestedReceipt.equivalentCnyAmount) }}
        </small>
        <small v-if="suggestedReceipt.estimatedProfit">
          预计利润 ¥{{ formatDecimal(suggestedReceipt.estimatedProfit) }}，利润率
          {{ suggestedReceipt.estimatedProfitRate }}%
        </small>
        <small v-else-if="!suggestedReceipt.error">
          {{
            pricingInputMode === 'receipt'
              ? '当前为实收反算；直接修改利润率可切换为目标定价'
              : '填写目标利润率并选择可用 ID 后自动计算推荐价'
          }}
        </small>
        <small
          v-if="
            recommendationApplied &&
            appliedSuggestedOriginal &&
            suggestedReceipt.originalAmount !== appliedSuggestedOriginal
          "
        >
          推荐价已更新，现有价格不会自动覆盖
        </small>
      </div>
      <div class="v2-order-entry-recommendation__actions">
        <AppButton v-if="recommendationApplied" variant="ghost" @click="emit('undoSuggested')">
          撤销采用
        </AppButton>
        <AppButton
          variant="ghost"
          :disabled="!suggestedReceipt.originalAmount"
          @click="emit('applySuggested')"
        >
          采用推荐价
        </AppButton>
      </div>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { V2OrderEntryForm } from '../order-entry-form';
import type { SuggestedReceiptQuote } from '../order-pricing';
import type { OrderPricingInputMode } from '../useOrderPricingInputMode';

const props = defineProps<{
  form: V2OrderEntryForm;
  suggestedReceipt: SuggestedReceiptQuote;
  recommendationApplied: boolean;
  appliedSuggestedOriginal: string;
  pricingInputMode: OrderPricingInputMode;
  formatDecimal: (value: string) => string;
}>();

const emit = defineEmits<{
  applySuggested: [];
  undoSuggested: [];
}>();

function formatReceiptAmount(value: string) {
  if (props.form.receivedCurrency === 'CNY') return `¥${props.formatDecimal(value)}`;
  const [integerPart = '0'] = value.split('.');
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (props.form.receivedCurrency === 'MYR') return `RM ${groupedInteger}`;
  if (props.form.receivedCurrency === 'USD') return `$${groupedInteger}`;
  return `${groupedInteger} USDT`;
}
</script>
