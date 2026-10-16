<template>
  <el-form-item class="recharge-full-row" label="ChatGPT 账号" required>
    <el-select
      v-model="accountId"
      filterable
      aria-label="选择 ChatGPT 账号"
      name="recharge-account-entry"
      autocomplete="off"
      placeholder="从 ChatGPT 账号资料中选择"
      :loading="loading"
      :disabled="disabled"
    >
      <el-option
        v-for="account in accounts"
        :key="account.id"
        :value="account.id"
        :label="rechargeAccountOptionLabel(account)"
      />
    </el-select>
    <p v-if="error" class="recharge-error" role="alert">
      {{ getApiErrorMessage(error) }}
      <AppButton size="small" variant="ghost" @click="emit('retry')">重试读取账号</AppButton>
    </p>
    <p class="recharge-note">
      已保存密码时使用密码登录，否则使用邮箱验证码登录。系统会按官网要求自动读取邮箱验证码或 2FA
      验证码；其他验证请在原比特窗口完成。
    </p>
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import type { BankChatgptAccount } from './bank-recharge-api';
import { rechargeAccountOptionLabel } from './recharge-account-options';
defineProps<{
  accounts: BankChatgptAccount[];
  loading: boolean;
  disabled: boolean;
  error: unknown;
}>();
const emit = defineEmits<{ retry: [] }>();
const accountId = defineModel<string>('accountId', { required: true });
</script>
