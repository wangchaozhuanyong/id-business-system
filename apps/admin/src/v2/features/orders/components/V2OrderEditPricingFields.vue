<template>
  <el-form-item label="结算平台" prop="settlementPlatformOptionId">
    <el-select
      v-model="form.settlementPlatformOptionId"
      filterable
      :disabled="!order.operations.canEditPricing"
      placeholder="请选择收款方式"
      @change="emit('settlementChange')"
    >
      <el-option
        v-for="platform in settlementChoices"
        :key="platform.id"
        :label="platform.name"
        :value="platform.id"
      />
    </el-select>
  </el-form-item>

  <el-form-item label="平台订单号" prop="platformOrderNo">
    <el-input
      v-model="form.platformOrderNo"
      maxlength="160"
      :disabled="!order.operations.canEditPricing || !form.settlementPlatformOptionId"
      placeholder="选填"
    />
  </el-form-item>

  <el-form-item :label="`原币实收（${order.receivedCurrency}）`" prop="receivedOriginalAmount">
    <el-input
      v-model="form.receivedOriginalAmount"
      clearable
      inputmode="decimal"
      maxlength="19"
      :disabled="!order.operations.canEditPricing"
      @input="emit('manualPriceInput')"
    />
  </el-form-item>

  <el-form-item label="人民币实收">
    <div class="v2-order-edit-readonly">
      <strong>¥{{ formatDecimal(receivedAmountPreview) }}</strong>
      <span v-if="order.receivedCurrency !== 'CNY'">
        沿用订单锁定汇率 {{ order.receivedFxRateToCny }}
      </span>
    </div>
  </el-form-item>

  <el-form-item label="预计平台手续费">
    <div class="v2-order-edit-readonly">
      <strong>¥{{ platformFeePreview }}</strong>
      <el-tag type="info" effect="plain">服务端复核</el-tag>
    </div>
  </el-form-item>

  <template v-if="order.operations.canEditPricing">
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
      <div class="v2-order-edit-recommendation">
        <div>
          <strong>
            {{
              suggestedOriginalAmount
                ? `${formatDecimal(suggestedOriginalAmount)} ${order.receivedCurrency}`
                : '—'
            }}
          </strong>
          <small v-if="suggestedReceived.error">{{ suggestedReceived.error }}</small>
          <small v-else-if="suggestedReceived.estimatedProfit">
            预计利润 ¥{{ formatDecimal(suggestedReceived.estimatedProfit) }}，利润率
            {{ suggestedReceived.estimatedProfitRate }}%
          </small>
          <small v-else>填写目标利润率后按当前成本反推</small>
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
        <div class="v2-order-edit-recommendation__actions">
          <AppButton v-if="recommendationApplied" variant="ghost" @click="emit('undoSuggested')">
            撤销采用
          </AppButton>
          <AppButton
            variant="ghost"
            :disabled="!suggestedOriginalAmount"
            @click="emit('applySuggested')"
          >
            采用推荐价
          </AppButton>
        </div>
      </div>
    </el-form-item>
  </template>

  <el-form-item label="预计利润率">
    <div class="v2-order-edit-readonly">
      <strong>
        {{ estimatedProfitRatePreview === null ? '—' : `${estimatedProfitRatePreview}%` }}
      </strong>
      <span>预计利润 ¥{{ formatDecimal(estimatedProfitPreview) }}</span>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { SuggestedReceivedAmount } from '@/v2/features/order-entry/order-pricing';
import type { V2Order, V2OrderEntrySettlementPlatform } from '../contracts';
import { formatDecimal, type OrderEditForm } from './order-edit-form';

defineProps<{
  form: OrderEditForm;
  order: V2Order;
  settlementChoices: V2OrderEntrySettlementPlatform[];
  receivedAmountPreview: string;
  platformFeePreview: string;
  suggestedReceived: SuggestedReceivedAmount;
  suggestedOriginalAmount: string | null;
  recommendationApplied: boolean;
  appliedSuggestedCny: string;
  estimatedProfitPreview: string;
  estimatedProfitRatePreview: string | null;
}>();

const emit = defineEmits<{
  settlementChange: [];
  manualPriceInput: [];
  applySuggested: [];
  undoSuggested: [];
}>();
</script>
