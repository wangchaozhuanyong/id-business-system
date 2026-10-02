<template>
  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-position="left"
    label-width="110px"
    require-asterisk-position="right"
    autocomplete="off"
  >
    <el-form-item label="银行卡名称" prop="label"
      ><el-input v-model="form.label" maxlength="80" placeholder="选填，默认使用卡尾号"
    /></el-form-item>
    <el-form-item label="持卡人姓名" prop="billingName">
      <el-input
        v-model="form.billingName"
        maxlength="120"
        placeholder="选填；留空则充值时从姓名库匹配"
      />
    </el-form-item>
    <el-form-item label="银行卡卡号" prop="number" :required="!editing">
      <el-input
        v-model="form.number"
        type="text"
        inputmode="numeric"
        maxlength="25"
        autocomplete="off"
        :placeholder="editing ? `当前尾号 ${editing.last4}；留空保留` : '输入完整卡号'"
      />
    </el-form-item>
    <el-form-item label="有效期" prop="expiry" :required="!editing">
      <el-input v-model="form.expiry" maxlength="5" placeholder="MM/YY" />
    </el-form-item>
    <V2BankCardCurrencySelect
      v-model="form.currencyCode"
      prop="currencyCode"
      select-label="银行卡付款币种"
      :currencies="activeCurrencies"
      :loading="loading"
    />
    <el-form-item v-if="editing" label="状态"
      ><el-switch v-model="form.active" active-text="启用" inactive-text="停用"
    /></el-form-item>
    <el-form-item label="备注1"><el-input v-model="form.remark1" maxlength="500" /></el-form-item>
    <el-form-item label="备注2"><el-input v-model="form.remark2" maxlength="500" /></el-form-item>
  </el-form>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { validateV2Form } from '@/v2/utils/formValidation';
import V2BankCardCurrencySelect from './V2BankCardCurrencySelect.vue';
import type { ManagedBankRechargeCard, BankRechargeCurrency } from './bank-recharge-api';
defineProps<{
  rules: FormRules;
  editing: ManagedBankRechargeCard | null;
  activeCurrencies: BankRechargeCurrency[];
  loading: boolean;
}>();
const form = defineModel<{
  label: string;
  billingName: string;
  number: string;
  expiry: string;
  currencyCode: string;
  active: boolean;
  remark1: string;
  remark2: string;
}>('form', { required: true });
const formRef = ref<FormInstance>();
defineExpose({ validate: () => validateV2Form(formRef.value) });
</script>
