<template>
  <el-form-item label="2FA 方式" required>
    <el-radio-group v-model="sourceModel">
      <el-radio-button value="secret">粘贴密钥</el-radio-button>
      <el-radio-button value="saved">已保存账号</el-radio-button>
      <el-radio-button value="manual">其他验证</el-radio-button>
    </el-radio-group>
  </el-form-item>
  <el-form-item
    v-if="source === 'secret'"
    label="2FA 密钥"
    required
    :error="secretInput ? secretError : ''"
  >
    <el-input
      v-model="secretModel"
      type="password"
      show-password
      autocomplete="off"
      autocapitalize="off"
      :spellcheck="false"
      :maxlength="V2_TOTP_INPUT_LIMITS.length"
      placeholder="粘贴 Base32 密钥或 otpauth 链接，不是当次验证码"
    />
  </el-form-item>
  <el-form-item v-if="source === 'saved'" label="已保存账号" required>
    <el-select
      v-model="savedAccountModel"
      aria-label="选择已保存的 2FA 账号"
      filterable
      :loading="loading"
      placeholder="选择本次 ChatGPT 账号的 2FA"
      no-data-text="尚无已保存的 2FA 账号"
    >
      <el-option
        v-for="item in savedAccounts"
        :key="item.id"
        :label="item.issuer ? `${item.name} · ${item.issuer}` : item.name"
        :value="item.id"
      />
    </el-select>
  </el-form-item>
  <p v-if="source === 'saved' && error" class="recharge-error" role="alert">
    {{ error }}
    <el-button link type="primary" @click="emit('retry')">重试</el-button>
  </p>
  <p class="recharge-note recharge-login-note">
    官网要求 TOTP 时自动取码并提交；邮箱验证码和真人验证在本次比特窗口完成。
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { V2_TOTP_INPUT_LIMITS } from '@/v2/components/workspace/totp';
import type { SavedAccountOption, TotpSource } from './useRechargeTotp';

const props = defineProps<{
  source: TotpSource;
  secretInput: string;
  savedAccountId: string;
  savedAccounts: readonly SavedAccountOption[];
  secretError: string;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{
  'update:source': [value: TotpSource];
  'update:secretInput': [value: string];
  'update:savedAccountId': [value: string];
  retry: [];
}>();

const sourceModel = computed({
  get: () => props.source,
  set: (value: TotpSource) => emit('update:source', value)
});
const secretModel = computed({
  get: () => props.secretInput,
  set: (value: string) => emit('update:secretInput', value)
});
const savedAccountModel = computed({
  get: () => props.savedAccountId,
  set: (value: string) => emit('update:savedAccountId', value)
});
</script>
