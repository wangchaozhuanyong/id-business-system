<template>
  <el-form-item v-if="!editing" label="ChatGPT 邮箱" prop="email" required>
    <el-input
      v-model="form.email"
      name="chatgpt-account-create-email"
      type="email"
      maxlength="250"
      autocomplete="off"
      placeholder="输入 ChatGPT 登录邮箱"
    />
  </el-form-item>
  <el-form-item v-else label="新邮箱" prop="email">
    <el-input
      v-model="form.email"
      name="chatgpt-account-edit-email"
      type="email"
      maxlength="250"
      autocomplete="off"
      :placeholder="`当前 ${editing.emailMasked}；留空保留`"
    />
  </el-form-item>
  <el-form-item label="国家" prop="registrationCountryCode">
    <el-select
      v-model="form.registrationCountryCode"
      aria-label="账号国家"
      placeholder="选择国家；未知可留空"
      filterable
      clearable
    >
      <el-option
        v-for="[code, label] in chatgptCountries"
        :key="code"
        :label="label"
        :value="code"
      />
    </el-select>
  </el-form-item>
  <el-form-item v-if="editing" label="优惠状况" prop="offerStatus">
    <ChatgptAccountOfferSelect
      :model-value="form.offerStatus"
      @update:model-value="setEditorOffer"
    />
  </el-form-item>
  <el-form-item label="登录密码">
    <el-input
      v-model="form.password"
      name="chatgpt-account-password"
      type="password"
      show-password
      maxlength="1024"
      autocomplete="new-password"
      :placeholder="editing ? '留空表示保留原密码' : '选填；未设置密码可留空'"
    />
  </el-form-item>
  <el-form-item label="2FA 密钥">
    <el-input
      v-model="form.totpSecret"
      type="password"
      show-password
      maxlength="2048"
      autocomplete="off"
      placeholder="Base32 密钥或 otpauth 链接；可稍后补充"
    />
  </el-form-item>
  <el-form-item v-if="editing" label="账号状态">
    <el-switch v-model="form.active" active-text="启用" inactive-text="停用" />
  </el-form-item>
  <el-form-item label="备注">
    <el-input v-model="form.remark" maxlength="500" placeholder="选填" />
  </el-form-item>
</template>

<script setup lang="ts">
import type { V2AccountOffer } from '@apple-business/shared';
import type { BankChatgptAccount } from './bank-recharge-api';
import ChatgptAccountOfferSelect from './ChatgptAccountOfferSelect.vue';
import { chatgptCountries } from './chatgpt-country';

interface AccountEditorForm {
  email: string;
  registrationCountryCode: string;
  password: string;
  totpSecret: string;
  remark: string;
  active: boolean;
  offerStatus: V2AccountOffer;
}

const form = defineModel<AccountEditorForm>('form', { required: true });
defineProps<{ editing: BankChatgptAccount | null }>();

function setEditorOffer(value: V2AccountOffer | 'all') {
  if (value !== 'all') form.value.offerStatus = value;
}
</script>
