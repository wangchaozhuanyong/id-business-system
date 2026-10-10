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
        :disabled="!account.hasPassword"
      />
    </el-select>
    <p v-if="error" class="recharge-error" role="alert">
      {{ getApiErrorMessage(error) }}
      <AppButton size="small" variant="ghost" @click="emit('retry')">重试读取账号</AppButton>
    </p>
    <p class="recharge-note">
      使用该账号已保存的登录密码。未保存密码时，请先到
      <router-link to="/v2/auto-recharge/chatgpt-accounts">ChatGPT 账号</router-link>补充登录密码。
      已保存 2FA 时自动取码，其他验证在所属比特窗口完成。
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
