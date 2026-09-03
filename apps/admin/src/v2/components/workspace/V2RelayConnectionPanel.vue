<template>
  <div class="v2-relay-connection-grid">
    <section class="v2-relay-card">
      <header>
        <span
          ><el-icon><Connection /></el-icon><strong>谷歌云</strong></span
        >
        <el-tag :type="connection.googleAuthorized ? 'success' : 'info'" effect="plain">
          {{
            connection.googleAuthorized
              ? '已授权'
              : connection.googleOAuthConfigured
                ? '待授权'
                : '未配置'
          }}
        </el-tag>
      </header>
      <p v-if="connection.googleEmail">当前账号：{{ connection.googleEmail }}</p>
      <el-form
        label-position="left"
        label-width="142px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="OAuth 客户端 ID" required>
          <el-input
            v-model="googleForm.clientId"
            autocomplete="off"
            placeholder="请输入在谷歌云创建的客户端 ID"
          />
        </el-form-item>
        <el-form-item label="OAuth 客户端密钥">
          <el-input
            v-model="googleForm.clientSecret"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="留空表示保留已保存的密钥"
          />
        </el-form-item>
        <el-form-item label="授权回调地址">
          <div class="v2-relay-copy-row">
            <el-input :model-value="connection.callbackUrl" readonly />
            <AppButton size="small" variant="soft" @click="copyText(connection.callbackUrl)"
              >复制</AppButton
            >
          </div>
        </el-form-item>
      </el-form>
      <div class="v2-relay-card__actions">
        <AppButton
          variant="soft"
          :loading="savingGoogleConfig"
          :disabled="!writesAllowed"
          @click="saveGoogleConfig"
          >保存配置</AppButton
        >
        <AppButton
          variant="primary"
          :loading="startingGoogleOAuth"
          :disabled="!connection.googleOAuthConfigured || !writesAllowed"
          @click="startGoogleOAuth"
        >
          {{ connection.googleAuthorized ? '重新授权 Google' : '授权 Google' }}
        </AppButton>
        <AppButton variant="ghost" @click="$emit('refresh')">刷新状态</AppButton>
      </div>
    </section>

    <section class="v2-relay-card">
      <header>
        <span
          ><el-icon><Link /></el-icon><strong>中转站</strong></span
        >
        <el-tag :type="connection.cloudBridgeConnected ? 'success' : 'info'" effect="plain">
          {{ connection.cloudBridgeConnected ? '已连接' : '未连接' }}
        </el-tag>
      </header>
      <p>固定连接：{{ connection.cloudBridgeOrigin }}</p>
      <el-form
        label-position="left"
        label-width="142px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="管理员邮箱" required
          ><el-input v-model="cloudBridgeForm.email" autocomplete="username"
        /></el-form-item>
        <el-form-item v-if="!cloudBridgeChallenge" label="管理员密码" required>
          <el-input
            v-model="cloudBridgeForm.password"
            type="password"
            show-password
            autocomplete="current-password"
            @keyup.enter="loginCloudBridge"
          />
        </el-form-item>
        <el-form-item v-else label="2FA 验证码" required>
          <el-input
            v-model="cloudBridgeForm.totpCode"
            inputmode="numeric"
            maxlength="8"
            autocomplete="one-time-code"
            @keyup.enter="loginCloudBridge"
          />
        </el-form-item>
      </el-form>
      <div class="v2-relay-card__actions">
        <AppButton
          variant="primary"
          :loading="loggingInCloudBridge"
          :disabled="!writesAllowed"
          @click="loginCloudBridge"
        >
          {{
            cloudBridgeChallenge
              ? '验证并连接'
              : connection.cloudBridgeConnected
                ? '重新连接'
                : '连接中转站'
          }}
        </AppButton>
        <AppButton v-if="cloudBridgeChallenge" variant="ghost" @click="cancelCloudBridgeChallenge"
          >返回登录</AppButton
        >
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { V2RelayConnectionStatus } from '@apple-business/shared';
import { Connection, Link } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';

const props = defineProps<{ connection: V2RelayConnectionStatus; writesAllowed: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const savingGoogleConfig = ref(false);
const startingGoogleOAuth = ref(false);
const loggingInCloudBridge = ref(false);
const cloudBridgeChallenge = ref('');
const googleForm = reactive({ clientId: '', clientSecret: '' });
const cloudBridgeForm = reactive({ email: '', password: '', totpCode: '' });

watch(
  () => props.connection.cloudBridgeEmail,
  (email) => {
    if (email && !cloudBridgeForm.email) cloudBridgeForm.email = email;
  },
  { immediate: true }
);

async function saveGoogleConfig() {
  if (!googleForm.clientId.trim()) return void ElMessage.warning('请输入 Google OAuth 客户端 ID');
  savingGoogleConfig.value = true;
  try {
    await idBusinessV2WorkspaceApi.saveRelayGoogleOAuth({
      clientId: googleForm.clientId.trim(),
      ...(googleForm.clientSecret ? { clientSecret: googleForm.clientSecret } : {})
    });
    googleForm.clientSecret = '';
    emit('refresh');
    ElMessage.success('Google OAuth 配置已保存');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    savingGoogleConfig.value = false;
  }
}

async function startGoogleOAuth() {
  startingGoogleOAuth.value = true;
  try {
    const result = await idBusinessV2WorkspaceApi.startRelayGoogleAuthorization();
    const opened = window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
    ElMessage.success('已打开 Google 授权窗口，完成后请刷新状态');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    startingGoogleOAuth.value = false;
  }
}

async function loginCloudBridge() {
  if (!cloudBridgeForm.email.trim()) return void ElMessage.warning('请输入中转站管理员邮箱');
  loggingInCloudBridge.value = true;
  try {
    const result = await idBusinessV2WorkspaceApi.loginRelayCloudBridge({
      email: cloudBridgeForm.email.trim(),
      ...(cloudBridgeChallenge.value
        ? { tempToken: cloudBridgeChallenge.value, totpCode: cloudBridgeForm.totpCode.trim() }
        : { password: cloudBridgeForm.password })
    });
    cloudBridgeForm.password = '';
    cloudBridgeForm.totpCode = '';
    if (result.twoFactorRequired && result.tempToken) {
      cloudBridgeChallenge.value = result.tempToken;
      ElMessage.info('请输入中转站 2FA 验证码');
      return;
    }
    cloudBridgeChallenge.value = '';
    emit('refresh');
    ElMessage.success('中转站连接成功');
  } catch (error) {
    cloudBridgeForm.password = '';
    cloudBridgeForm.totpCode = '';
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    loggingInCloudBridge.value = false;
  }
}

function cancelCloudBridgeChallenge() {
  cloudBridgeChallenge.value = '';
  cloudBridgeForm.totpCode = '';
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败，请手动复制');
  }
}
</script>
