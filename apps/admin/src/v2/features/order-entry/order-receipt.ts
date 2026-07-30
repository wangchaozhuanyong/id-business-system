import type { FormRules } from 'element-plus';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { V2_DECIMAL_PLACES, isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import { isNonNegativeOrderAmount } from './order-pricing';
import type { V2OrderEntryForm } from './order-entry-form';

export function calculateReceivedAmountPreview(form: V2OrderEntryForm) {
  if (!isNonNegativeOrderAmount(form.receivedOriginalAmount)) return '';
  if (form.receivedCurrency === 'CNY') return form.receivedOriginalAmount;
  const rate = form.receivedFxRateToCny || form.automaticFxRateToCny;
  if (
    !isV2UnsignedDecimal(rate, {
      allowZero: false,
      decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
    })
  ) {
    return '';
  }
  return multiplyDecimalStrings(form.receivedOriginalAmount, rate);
}

export function createOrderReceiptRules(form: V2OrderEntryForm): FormRules {
  return {
    receivedOriginalAmount: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          callback(
            isNonNegativeOrderAmount(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`)
          );
        },
        trigger: 'blur'
      }
    ],
    receivedCurrency: [{ required: true, message: '请选择收款币种', trigger: 'change' }],
    receivedFxRateToCny: [
      {
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          callback(
            !normalized ||
              isV2UnsignedDecimal(normalized, {
                allowZero: false,
                decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
              })
              ? undefined
              : new Error(`汇率必须是最多 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数的正数`)
          );
        },
        trigger: 'blur'
      }
    ],
    receivedManualRateReason: [
      {
        validator: (_rule, value, callback) => {
          callback(
            form.receivedFxRateToCny && !String(value ?? '').trim()
              ? new Error('手工填写汇率时必须说明来源')
              : undefined
          );
        },
        trigger: 'blur'
      }
    ]
  };
}

export function resetReceiptCurrencyEvidence(form: V2OrderEntryForm) {
  form.receivedFxRateToCny = '';
  form.receivedFxSnapshotId = '';
  form.automaticFxRateToCny = '';
  form.receivedManualRateReason = '';
}
