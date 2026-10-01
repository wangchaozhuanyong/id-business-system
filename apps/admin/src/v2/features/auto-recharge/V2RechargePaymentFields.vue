<template>
  <div class="recharge-payment-fields">
    <el-form-item
      v-for="field in rechargePaymentFields"
      :key="field.key"
      :class="{ 'recharge-card-number': field.key === 'number' }"
      :label="field.label"
      :prop="field.key"
      :required="field.required"
    >
      <el-input
        v-if="field.key === 'expiry'"
        :model-value="details.expiry"
        :placeholder="field.placeholder"
        inputmode="numeric"
        autocomplete="off"
        @update:model-value="details.expiry = formatRechargeExpiry(String($event))"
      />
      <el-input
        v-else
        v-model="details[field.key]"
        :type="field.secret ? 'password' : 'text'"
        :show-password="field.secret"
        :maxlength="field.max"
        :placeholder="field.placeholder"
        autocomplete="off"
      />
    </el-form-item>
  </div>
</template>

<script setup lang="ts">
import type { V2RechargeDetails } from './contracts';
import { formatRechargeExpiry, rechargePaymentFields } from './recharge-form';

const details = defineModel<V2RechargeDetails>({ required: true });
</script>
