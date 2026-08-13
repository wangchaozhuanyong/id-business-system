<template>
  <div class="v2-order-entry-form-column">
    <el-form-item label="收款币种" prop="receivedCurrency">
      <el-select v-model="form.receivedCurrency" @change="emit('currencyChange')">
        <el-option label="人民币 CNY" value="CNY" />
        <el-option label="马币 MYR" value="MYR" />
        <el-option label="美元 USD" value="USD" />
        <el-option label="USDT" value="USDT" />
      </el-select>
    </el-form-item>

    <el-form-item label="售卖价格" prop="receivedOriginalAmount">
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
      <el-form-item label="汇率方式" prop="receivedManualRateReason">
        <div class="v2-order-entry-fx-control">
          <el-radio-group
            :model-value="form.receivedFxMode"
            class="v2-order-entry-fx-mode"
            @change="handleFxModeChange"
          >
            <el-radio-button value="automatic">自动</el-radio-button>
            <el-radio-button value="manual">手动</el-radio-button>
          </el-radio-group>

          <div
            v-if="form.receivedFxMode === 'automatic'"
            class="v2-order-entry-readonly v2-order-entry-fx-quote"
            :class="{ 'is-error': receiptFxError }"
            role="status"
            aria-live="polite"
          >
            <div>
              <strong>
                {{
                  receiptFxLoading
                    ? `正在采集 ${form.receivedCurrency}/CNY 汇率`
                    : form.automaticFxRateToCny
                      ? `1 ${form.receivedCurrency} = ¥${form.automaticFxRateToCny}`
                      : '暂无可用汇率'
                }}
              </strong>
              <span v-if="receiptFxQuote && form.automaticFxRateToCny">
                {{ sourceLabel(receiptFxQuote.source) }} · 采集于
                {{ formatQuoteTime(receiptFxQuote.capturedAt) }}
                <template v-if="receiptFxQuote.expiresAt">
                  · 有效至 {{ formatQuoteTime(receiptFxQuote.expiresAt) }}
                </template>
              </span>
              <span v-else-if="receiptFxError">{{ receiptFxError }}</span>
              <span v-else-if="!receiptFxLoading"
                >暂无快照时不会用 0 代替，请重新采集或切到手动</span
              >
            </div>
            <AppButton
              v-if="receiptFxError && !receiptFxLoading"
              variant="ghost"
              @click="emit('retryFxQuote')"
            >
              重新采集
            </AppButton>
          </div>

          <div v-else class="v2-order-entry-fx-manual">
            <el-input
              v-model="form.receivedFxRateToCny"
              inputmode="decimal"
              placeholder="填写 1 原币折算人民币汇率"
              @input="emit('manualRateInput')"
            />
            <el-input
              v-model="form.receivedManualRateReason"
              maxlength="200"
              placeholder="说明手动汇率来源/原因，至少 2 个字符"
            />
          </div>
        </div>
      </el-form-item>
    </template>

    <el-form-item label="折算人民币">
      <div class="v2-order-entry-readonly">
        <strong>
          {{
            receivedAmountPreview
              ? `¥${formatDecimal(receivedAmountPreview)}`
              : form.receivedCurrency !== 'CNY' && receiptFxLoading
                ? '等待汇率采集'
                : '等待售卖价格与有效汇率'
          }}
        </strong>
        <span>成交时锁定交易汇率，历史利润不会随最新汇率漂移</span>
      </div>
    </el-form-item>
  </div>
</template>

<script setup lang="ts">
import type { V2FinanceFxRateSnapshot, V2OrderReceiptFxQuote } from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2OrderEntryForm } from '../order-entry-form';

defineProps<{
  form: V2OrderEntryForm;
  receivedAmountPreview: string;
  receiptFxQuote: V2OrderReceiptFxQuote | null;
  receiptFxLoading: boolean;
  receiptFxError: string;
  formatDecimal: (value: string) => string;
}>();

const emit = defineEmits<{
  currencyChange: [];
  priceInput: [];
  fxModeChange: [mode: V2OrderEntryForm['receivedFxMode']];
  manualRateInput: [];
  retryFxQuote: [];
}>();

function handleFxModeChange(value: unknown) {
  if (value === 'automatic' || value === 'manual') {
    emit('fxModeChange', value);
  }
}

function sourceLabel(source: V2FinanceFxRateSnapshot['source']) {
  if (source === 'ecb_cross') return 'ECB 国际参考交叉汇率';
  if (source === 'combined_p2p') return 'Binance + OKX P2P 综合价';
  if (source === 'cny_fixed') return '人民币固定汇率';
  if (source === 'manual') return '人工汇率';
  return source.toUpperCase();
}

function formatQuoteTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}
</script>
