<template>
  <el-form-item label="ChatGPT 账号" required>
    <el-input
      v-model="email"
      name="chatgpt-recharge-email"
      type="email"
      autocomplete="off"
      maxlength="250"
      placeholder="输入账号邮箱"
    >
      <template #append>
        <el-dropdown :disabled="disabled || loading" trigger="click" @command="selectAccount">
          <AppButton size="small" variant="ghost" :disabled="disabled || loading">
            {{ loading ? '读取账号中' : '选择账号' }}
          </AppButton>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="account in accounts"
                :key="account.id"
                :command="account.id"
                :disabled="!account.hasPassword"
              >
                {{ account.emailMasked }}{{ account.hasPassword ? '' : ' · 请先补充密码' }}
              </el-dropdown-item>
              <el-dropdown-item v-if="!accounts.length" disabled>暂无待用账号</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </el-input>
    <p v-if="error" class="recharge-error" role="alert">
      {{ getApiErrorMessage(error) }}
      <AppButton size="small" variant="ghost" @click="emit('retry')">重试读取账号</AppButton>
    </p>
  </el-form-item>
  <el-form-item label="登录密码" required>
    <!-- 第三方账号凭据，避免浏览器回填本站保存的登录密码。 -->
    <el-input
      v-model="password"
      name="chatgpt-recharge-password"
      type="password"
      show-password
      autocomplete="new-password"
      maxlength="1024"
      placeholder="仅用于本次官网登录"
    />
  </el-form-item>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import type { BankChatgptAccount } from './bank-recharge-api';
const props = defineProps<{
  accounts: BankChatgptAccount[];
  loading: boolean;
  disabled: boolean;
  error: unknown;
}>();
const emit = defineEmits<{ retry: [] }>();
const email = defineModel<string>('email', { required: true });
const password = defineModel<string>('password', { required: true });
const accountId = defineModel<string>('accountId', { required: true });
const loginMethod = defineModel<'json' | 'password' | 'saved'>('loginMethod', { required: true });
function selectAccount(id: string) {
  if (props.disabled || !props.accounts.some((account) => account.id === id && account.hasPassword))
    return;
  accountId.value = id;
  loginMethod.value = 'saved';
}
</script>
