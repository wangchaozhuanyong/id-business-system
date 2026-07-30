<template>
  <el-form-item label="收款币种" prop="receivedCurrency">
    <el-select v-model="form.receivedCurrency" @change="emit('currencyChange')">
      <el-option label="人民币 CNY" value="CNY" />
      <el-option label="马币 MYR" value="MYR" />
      <el-option label="USDT" value="USDT" />
    </el-select>
  </el-form-item>

  <el-form-item label="原币实收" prop="receivedOriginalAmount">
    <el-input
      v-model="form.receivedOriginalAmount"
      clearable
      inputmode="decimal"
      maxlength="19"
      :placeholder="`例如 100 ${form.receivedCurrency}`"
      @input="emit('priceInput')"
    />
  </el-form-item>

  <template v-if="form.receivedCurrency !== 'CNY'">
    <el-form-item label="手工汇率" prop="receivedFxRateToCny">
      <el-input
        v-model="form.receivedFxRateToCny"
        inputmode="decimal"
        placeholder="留空则保存时自动采集"
      />
    </el-form-item>
    <el-form-item v-if="!form.receivedFxRateToCny" label="可用汇率">
      <div class="v2-order-entry-readonly">
        <strong>
          {{
            form.automaticFxRateToCny
              ? `1 ${form.receivedCurrency} = ¥${form.automaticFxRateToCny}`
              : '暂无可用汇率'
          }}
        </strong>
        <span>
          {{
            form.automaticFxRateToCny
              ? '采用推荐价时锁定该汇率快照'
              : '可填写手工汇率；缺少汇率时不能采用推荐价'
          }}
        </span>
      </div>
    </el-form-item>
    <el-form-item v-if="form.receivedFxRateToCny" label="汇率原因" prop="receivedManualRateReason">
      <el-input
        v-model="form.receivedManualRateReason"
        maxlength="200"
        placeholder="说明手工汇率来源"
      />
    </el-form-item>
  </template>

  <el-form-item label="人民币实收">
    <div class="v2-order-entry-readonly">
      <strong>
        {{
          receivedAmountPreview
            ? `¥${formatDecimal(receivedAmountPreview)}`
            : '保存时按交易汇率计算'
        }}
      </strong>
      <span>交易汇率会锁定，历史利润不会随最新汇率漂移</span>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import type { V2OrderEntryForm } from '../order-entry-form';

defineProps<{
  form: V2OrderEntryForm;
  receivedAmountPreview: string;
  formatDecimal: (value: string) => string;
}>();

const emit = defineEmits<{
  currencyChange: [];
  priceInput: [];
}>();
</script>
