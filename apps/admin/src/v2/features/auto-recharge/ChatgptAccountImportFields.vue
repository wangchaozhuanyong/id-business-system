<template>
  <el-form label-position="left" label-width="112px" require-asterisk-position="right">
    <el-form-item label="资料格式">
      <el-select v-model="format" aria-label="账号导入格式">
        <el-option label="邮箱＋2FA（无密码）" value="without_password" />
        <el-option label="邮箱＋密码＋2FA" value="with_password" />
      </el-select>
    </el-form-item>
    <el-form-item label="账号资料" required>
      <el-input
        v-model="text"
        type="textarea"
        :rows="12"
        :maxlength="256000"
        autocomplete="off"
        aria-label="粘贴 ChatGPT 账号资料"
        :placeholder="
          format === 'without_password'
            ? 'user@example.com 2FA密钥 备注'
            : 'user@example.com 密码或- 2FA密钥或- 备注'
        "
      />
    </el-form-item>
  </el-form>
  <p class="bank-recharge-form-note">
    {{
      format === 'without_password'
        ? '依次填写邮箱、2FA 密钥、备注；不需要密码。'
        : '依次填写邮箱、密码、2FA 密钥、备注；密码可留空。'
    }}
    列之间可用 Tab 或空格；Tab 支持空列，空格分隔时用 - 占位。2FA 和备注可省略，备注中的空格会合并。
    每次最多 200 行。
  </p>
</template>

<script setup lang="ts">
import type { ChatgptAccountImportFormat } from './chatgpt-account-import';

const text = defineModel<string>({ required: true });
const format = defineModel<ChatgptAccountImportFormat>('format', { required: true });
</script>
