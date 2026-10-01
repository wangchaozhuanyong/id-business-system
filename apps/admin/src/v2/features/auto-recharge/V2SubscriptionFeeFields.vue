<template>
  <template v-if="selected?.accountingVersion !== 'subscription_cost_v2'">
    <el-alert
      type="warning"
      :closable="false"
      title="旧账务口径：原费用保留，不能自动转换为新费用。"
    />
    <el-form-item label="原客户手续费"
      ><span
        >{{ selected?.customerFeeAmount }} {{ selected?.chargeCurrencyCode }}（原比例
        {{ selected?.customerFeeRate }}%）</span
      ></el-form-item
    >
    <el-form-item label="原银行手续费"
      ><span
        >{{ selected?.bankFeeAmount ?? '未记录' }} {{ selected?.bankFeeCurrencyCode }}</span
      ></el-form-item
    >
    <el-form-item v-if="!readonly" label="转换账务口径"
      ><el-checkbox
        :model-value="form.confirmFeeConversion"
        @update:model-value="setField('confirmFeeConversion', $event)"
        >已重新核对以下两项费用</el-checkbox
      ></el-form-item
    >
  </template>
  <template v-if="newFeeMode">
    <template v-for="fee in fees" :key="fee.prefix">
      <el-form-item :label="fee.label" required
        ><el-input
          :model-value="form[`${fee.prefix}Amount`]"
          :disabled="readonly"
          inputmode="decimal"
          placeholder="没有费用填 0；空值表示待核对"
          @update:model-value="setField(`${fee.prefix}Amount`, $event)"
      /></el-form-item>
      <el-form-item :label="`${fee.short}扣费币种`" required
        ><V2FinanceCurrencySelect
          :model-value="form[`${fee.prefix}CurrencyCode`]"
          :disabled="readonly"
          @update:model-value="setField(`${fee.prefix}CurrencyCode`, $event)"
          @change="clearAccount(fee.prefix)"
      /></el-form-item>
      <el-form-item :label="`${fee.short}付款账户`" :required="positive(fee.prefix)"
        ><el-select
          :model-value="form[`${fee.prefix}FinanceAccountId`]"
          clearable
          filterable
          :disabled="readonly"
          :aria-label="`${fee.label}付款账户`"
          @update:model-value="setField(`${fee.prefix}FinanceAccountId`, $event)"
          ><el-option
            v-for="account in accounts.filter(
              (item) => item.currency === form[`${fee.prefix}CurrencyCode`]
            )"
            :key="account.id"
            :label="account.name"
            :value="account.id" /></el-select
      ></el-form-item>
      <template v-if="positive(fee.prefix) && form[`${fee.prefix}CurrencyCode`] !== 'CNY'">
        <el-form-item :label="`${fee.short}人民币汇率`"
          ><el-input
            :model-value="form[`${fee.prefix}FxRateToCny`]"
            inputmode="decimal"
            :disabled="readonly"
            placeholder="留空使用有效汇率；1 原币折合人民币"
            @update:model-value="setField(`${fee.prefix}FxRateToCny`, $event)"
        /></el-form-item>
        <el-form-item v-if="!readonly" :label="`${fee.short}汇率原因`"
          ><el-input
            :model-value="form[`${fee.prefix}ManualRateReason`]"
            maxlength="500"
            placeholder="新增或修改人工汇率时必填"
            @update:model-value="setField(`${fee.prefix}ManualRateReason`, $event)"
        /></el-form-item>
      </template>
      <el-form-item :label="`${fee.short}费用占本金比例`"
        ><span>{{ percentage(fee.prefix) }}</span></el-form-item
      >
    </template>
    <p class="bank-recharge-form-note">
      两项费用独立计入成本；只读比例按人民币金额计算。未核对费用不能完成入账。
    </p>
  </template>
</template>
<script setup lang="ts">
import {
  divideDecimalStrings,
  multiplyDecimalStrings,
  roundDecimalString,
  isV2UnsignedDecimal
} from '@apple-business/shared';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import type { BankRechargeOrder, BankRechargeOrderOptions } from './bank-recharge-api';
import type { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';
const props = defineProps<{
  form: ReturnType<typeof useBankRechargeOrdersPage>['form'];
  selected: BankRechargeOrder | null;
  readonly: boolean;
  newFeeMode: boolean;
  accounts: BankRechargeOrderOptions['financeAccounts'];
}>();
const fees = [
  { prefix: 'usdtFee', label: 'USDT 手续费', short: 'USDT' },
  { prefix: 'shoppingFee', label: '购物网手续费', short: '购物网' }
] as const;
const emit = defineEmits<{ change: [value: Partial<typeof props.form>] }>();
function setField(field: keyof typeof props.form, value: string | boolean) {
  emit('change', { [field]: value });
}
type Prefix = (typeof fees)[number]['prefix'];
function positive(prefix: Prefix) {
  return isV2UnsignedDecimal(props.form[`${prefix}Amount`], { allowZero: false, decimalPlaces: 4 });
}
function clearAccount(prefix: Prefix) {
  emit('change', {
    [`${prefix}FinanceAccountId`]: '',
    [`${prefix}FxRateToCny`]: '',
    [`${prefix}ManualRateReason`]: ''
  });
}
function percentage(prefix: Prefix) {
  if (!props.form[`${prefix}Amount`]) return '费用待核对';
  try {
    const rate =
      props.form[`${prefix}CurrencyCode`] === 'CNY' ? '1' : props.form[`${prefix}FxRateToCny`];
    const fee = /^0(?:\.0+)?$/.test(props.form[`${prefix}Amount`])
      ? '0'
      : multiplyDecimalStrings(props.form[`${prefix}Amount`], rate);
    const principal = multiplyDecimalStrings(
      props.form.chargeAmount,
      props.form.chargeFxRateToCny || (props.form.chargeCurrencyCode === 'CNY' ? '1' : '')
    );
    return `${roundDecimalString(divideDecimalStrings(multiplyDecimalStrings(fee, '100'), principal), 4)}%`;
  } catch {
    return '待核对本金或汇率';
  }
}
</script>
