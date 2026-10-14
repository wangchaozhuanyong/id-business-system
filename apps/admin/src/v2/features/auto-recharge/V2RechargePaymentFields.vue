<template>
  <div class="recharge-payment-fields">
    <el-form-item
      v-for="field in rechargePaymentFields"
      :key="field.key"
      :class="{
        'recharge-card-number': field.key === 'number',
        'recharge-card-expiry': field.key === 'expiry'
      }"
      :label="field.label"
      :prop="field.key"
      :required="field.required"
    >
      <el-input
        v-if="field.key === 'expiry'"
        :model-value="details.expiry"
        :validate-event="validateEvent !== false"
        :placeholder="field.placeholder"
        inputmode="numeric"
        name="recharge-entry-expiry"
        autocomplete="off"
        @update:model-value="details.expiry = formatRechargeExpiry(String($event))"
      />
      <RechargeSensitiveInput
        v-else-if="field.secret"
        v-model="details[field.key]"
        :validate-event="validateEvent !== false"
        :maxlength="field.max"
        :name="`recharge-entry-${field.key}`"
        :placeholder="field.placeholder"
        inputmode="numeric"
      />
      <el-input
        v-else
        v-model="details[field.key]"
        :validate-event="validateEvent !== false"
        :maxlength="field.max"
        :name="`recharge-entry-${field.key}`"
        :placeholder="field.placeholder"
        autocomplete="off"
      />
    </el-form-item>
  </div>
</template>

<script setup lang="ts">
import type { V2RechargeDetails } from './contracts';
import { formatRechargeExpiry, rechargePaymentFields } from './recharge-form';
import RechargeSensitiveInput from './RechargeSensitiveInput.vue';

defineProps<{
  validateEvent?: boolean;
}>();
const details = defineModel<V2RechargeDetails>({ required: true });
</script>
