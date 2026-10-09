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
        :readonly="field.key === 'name' && nameConfirmed"
      />
      <template v-if="field.key === 'name'">
        <p v-if="nameLoading" role="status">正在匹配姓名…</p>
        <p v-else-if="nameError" class="recharge-error" role="alert">
          {{ nameError }} <AppButton size="small" @click="nameMatch?.retry()">重试</AppButton>
        </p>
        <p v-else-if="nameConfirmed" class="recharge-note">已回填这张银行卡的绑定姓名</p>
      </template>
    </el-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed, type Ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RechargeDetails } from './contracts';
import { formatRechargeExpiry, rechargePaymentFields } from './recharge-form';
import RechargeSensitiveInput from './RechargeSensitiveInput.vue';

const props = defineProps<{
  validateEvent?: boolean;
  nameMatch?: {
    loading: Ref<boolean>;
    error: Ref<string>;
    confirmed: Ref<boolean>;
    retry: () => Promise<void>;
  };
}>();
const nameLoading = computed(() => props.nameMatch?.loading.value ?? false);
const nameError = computed(() => props.nameMatch?.error.value ?? '');
const nameConfirmed = computed(() => props.nameMatch?.confirmed.value ?? false);
const details = defineModel<V2RechargeDetails>({ required: true });
</script>
