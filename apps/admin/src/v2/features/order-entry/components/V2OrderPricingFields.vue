<template>
  <el-form-item label="目标利润率" prop="targetProfitRate">
    <el-input
      v-model="form.targetProfitRate"
      clearable
      inputmode="decimal"
      maxlength="8"
      placeholder="选填，例如 10"
    >
      <template #append>%</template>
    </el-input>
  </el-form-item>

  <el-form-item label="推荐价格">
    <div class="v2-order-entry-recommendation">
      <div>
        <strong>
          {{ suggestedReceived.amount ? `¥${formatDecimal(suggestedReceived.amount)}` : '-' }}
        </strong>
        <small v-if="suggestedReceived.error">{{ suggestedReceived.error }}</small>
        <small v-else-if="suggestedReceived.estimatedProfit">
          预计利润 ¥{{ formatDecimal(suggestedReceived.estimatedProfit) }}，利润率
          {{ suggestedReceived.estimatedProfitRate }}%
        </small>
        <small v-else>填写目标利润率并选择可用 ID 后自动计算人民币推荐价</small>
        <small
          v-if="
            recommendationApplied &&
            appliedSuggestedCny &&
            suggestedReceived.amount !== appliedSuggestedCny
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
          :disabled="!suggestedReceived.amount"
          @click="emit('applySuggested')"
        >
          采用推荐价
        </AppButton>
      </div>
    </div>
  </el-form-item>

  <el-form-item label="预计平台手续费">
    <div class="v2-order-entry-readonly">
      <strong>¥{{ formatDecimal(platformFeePreview) }}</strong>
      <el-tag type="info" effect="plain">服务端复核</el-tag>
    </div>
  </el-form-item>

  <el-form-item label="预计利润率">
    <div class="v2-order-entry-readonly">
      <strong>
        {{ estimatedProfitRatePreview === null ? '—' : `${estimatedProfitRatePreview}%` }}
      </strong>
      <span>预计利润 ¥{{ formatDecimal(estimatedProfitPreview) }}</span>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { V2OrderEntryForm } from '../order-entry-form';
import type { SuggestedReceivedAmount } from '../order-pricing';

defineProps<{
  form: V2OrderEntryForm;
  suggestedReceived: SuggestedReceivedAmount;
  recommendationApplied: boolean;
  appliedSuggestedCny: string;
  platformFeePreview: string;
  estimatedProfitPreview: string;
  estimatedProfitRatePreview: string | null;
  formatDecimal: (value: string) => string;
}>();

const emit = defineEmits<{
  applySuggested: [];
  undoSuggested: [];
}>();
</script>
