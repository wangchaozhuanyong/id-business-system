<template>
  <main class="login-page">
    <aside class="login-showcase" aria-label="系统说明">
      <div class="login-brand">
        <span class="login-brand__mark">ID</span>
        <div>
          <strong>ID 业务管理</strong>
          <span>Apple ID 订阅运营</span>
        </div>
      </div>

      <div class="login-showcase__content">
        <h1>把订单、余额与续费任务<br />放进同一套工作流</h1>
      </div>

      <ul class="login-capabilities" aria-label="系统能力">
        <li>
          <span
            ><el-icon><List /></el-icon
          ></span>
          <div>
            <strong>清晰的任务流</strong>
            <small>从客户、订单到续费，一条路径高效处理。</small>
          </div>
        </li>
        <li>
          <span
            ><el-icon><PieChart /></el-icon
          ></span>
          <div>
            <strong>完整的账务视图</strong>
            <small>余额、账单、收款一体化，数据实时可追溯。</small>
          </div>
        </li>
        <li>
          <span
            ><el-icon><Lock /></el-icon
          ></span>
          <div>
            <strong>受控的敏感访问</strong>
            <small>最小权限、操作留痕，保障数据与资金安全。</small>
          </div>
        </li>
      </ul>

      <p class="login-showcase__footer">© 2026 Apple 内部系统 · 仅限授权人员访问</p>
    </aside>

    <section class="login-panel">
      <div class="v2-login-appearance">
        <div class="v2-login-theme" role="group" aria-label="登录页主题">
          <span
            ><el-icon><Sunny /></el-icon>浅色</span
          >
          <el-switch
            :model-value="currentTheme === 'dark'"
            aria-label="切换深色主题"
            @change="handleThemeSwitch"
          />
          <span>深色</span>
        </div>
        <span
          class="v2-login-status"
          :class="`is-${systemHealthStatus}`"
          role="status"
          aria-live="polite"
        >
          <i />
          {{ systemHealthText }}
        </span>
      </div>

      <div class="login-heading">
        <h2>管理员登录</h2>
        <p class="v2-login-note">使用内部管理员账号继续，本系统不提供用户注册</p>
      </div>

      <el-form
        id="v2-admin-login-form"
        ref="formRef"
        :model="form"
        :rules="rules"
        :aria-busy="loading"
        :aria-describedby="loginError ? 'v2-login-error-message' : undefined"
        class="v2-horizontal-form v2-login-form"
        label-position="left"
        label-width="168px"
        require-asterisk-position="right"
        @submit.prevent="submit"
      >
        <el-form-item prop="username">
          <template #label>管理员账号</template>
          <el-input
            v-model.trim="form.username"
            autocomplete="username"
            maxlength="80"
            name="username"
            placeholder="请输入管理员账号"
          >
            <template #prefix>
              <el-icon><User /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item prop="password">
          <template #label>密码</template>
          <el-input
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            maxlength="160"
            name="password"
            placeholder="请输入密码"
            show-password
          >
            <template #prefix>
              <el-icon><Lock /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item prop="mfaCode">
          <template #label>动态验证码 / 恢复码（未启用 MFA 可留空）</template>
          <el-input
            v-model.trim="form.mfaCode"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="64"
            name="one-time-code"
            placeholder="请输入 6 位动态验证码或恢复码（可留空）"
          >
            <template #prefix>
              <el-icon><Key /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <div
          v-if="loginError"
          id="v2-login-error-message"
          class="login-error"
          role="alert"
          aria-live="assertive"
        >
          <strong>登录失败</strong>
          <span>{{ loginError }}</span>
        </div>

        <AppButton
          variant="primary"
          class="full-button"
          native-type="submit"
          :disabled="loading"
          :loading="loading"
        >
          登录新版后台
        </AppButton>

        <p class="v2-login-security">
          <el-icon><Lock /></el-icon>
          为保障安全，请勿将账号密码泄露给他人。所有操作均会被记录。
        </p>
      </el-form>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { Key, List, Lock, PieChart, Sunny, User } from '@element-plus/icons-vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getApiErrorMessage, http, request } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import { getSafeV2Redirect } from '@/v2/router/passwordReset';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { getPreferredV2Theme, persistV2Theme, type V2Theme } from '@/v2/theme';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const formRef = ref<FormInstance>();
const loading = ref(false);
const loginError = ref('');
const currentTheme = ref<V2Theme>(getPreferredV2Theme());
const systemHealthStatus = ref<'checking' | 'ready' | 'unavailable'>('checking');
const systemHealthText = computed(() => {
  if (systemHealthStatus.value === 'ready') return '系统运行正常';
  if (systemHealthStatus.value === 'unavailable') return '系统暂时不可用';
  return '正在检测系统';
});

const form = reactive({
  username: '',
  password: '',
  mfaCode: ''
});

const rules: FormRules<typeof form> = {
  username: [{ required: true, message: '请输入管理员账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
};

function setTheme(theme: V2Theme) {
  currentTheme.value = theme;
  persistV2Theme(theme);
}

function handleThemeSwitch(value: string | number | boolean) {
  setTheme(value === true ? 'dark' : 'light');
}

async function checkSystemHealth() {
  systemHealthStatus.value = 'checking';
  try {
    const result = await request<{ status: string; database: string }>(
      http.get('/health/ready', { timeout: 4000 })
    );
    systemHealthStatus.value =
      result.status === 'ready' && result.database === 'ok' ? 'ready' : 'unavailable';
  } catch {
    systemHealthStatus.value = 'unavailable';
  }
}

async function submit() {
  if (loading.value) return;

  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  loginError.value = '';
  try {
    await authStore.login(form.username, form.password, form.mfaCode || undefined);
    await router.push(getLoginRedirectPath());
  } catch (error) {
    loginError.value = getLoginErrorMessage(error);
    ElMessage.error(loginError.value);
  } finally {
    loading.value = false;
  }
}

function getLoginRedirectPath() {
  return getSafeV2Redirect(route.query.redirect);
}

function getLoginErrorMessage(error: unknown) {
  const message = getApiErrorMessage(error);

  if (message.includes('登录状态无效') || message.includes('登录状态已过期')) {
    return '账号、密码或动态验证码不正确，请检查后重试。';
  }

  return message;
}

watch(
  () => [form.username, form.password, form.mfaCode],
  () => {
    loginError.value = '';
  }
);

onMounted(() => {
  void checkSystemHealth();
});
</script>

<style scoped>
.v2-login-note {
  margin: 14px 0 0;
  color: var(--v3-text-soft);
  font-size: 14px;
  line-height: 1.6;
}

.v2-login-appearance {
  position: absolute;
  top: 34px;
  right: clamp(28px, 5vw, 72px);
  left: clamp(28px, 5vw, 72px);
  display: flex;
  width: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 22px;
}

.v2-login-theme {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--v3-text);
  font-size: 13px;
  font-weight: 600;
}

.v2-login-theme span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.v2-login-theme :deep(.el-switch) {
  --el-switch-on-color: var(--v3-primary);
  --el-switch-off-color: var(--v3-border);
}

.v2-login-status {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--v3-text);
  font-size: 13px;
  font-weight: 600;
}

.v2-login-status i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--v3-success-solid);
}

.v2-login-status.is-checking i {
  background: var(--v3-warning-solid);
}

.v2-login-status.is-unavailable {
  color: var(--v3-danger);
}

.v2-login-status.is-unavailable i {
  background: var(--v3-danger-solid);
}

.v2-login-security {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 0;
  color: var(--v3-text-soft);
  font-size: 13px;
  line-height: 1.55;
  text-align: left;
}

.v2-login-security .el-icon {
  flex: 0 0 auto;
  color: var(--v3-muted);
  font-size: 17px;
}

.login-panel :deep(.el-form) {
  display: grid;
  gap: 22px;
}

.login-panel :deep(.el-form-item) {
  margin: 0;
}

.login-panel :deep(.el-form-item__label) {
  height: auto;
  margin: 0 0 9px;
  padding: 0;
  color: var(--v3-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.login-panel :deep(.el-input__wrapper) {
  min-height: 56px;
  padding: 0 16px;
  border: 1px solid var(--v3-border);
  border-radius: 7px;
  background: var(--v3-surface);
  box-shadow: none;
}

.login-panel :deep(.el-input__wrapper:hover) {
  border-color: var(--v3-muted);
  box-shadow: none;
}

.login-panel :deep(.el-input__wrapper.is-focus) {
  border-color: var(--v3-primary);
  box-shadow: var(--v3-focus-ring);
}

.login-panel :deep(.el-input__prefix) {
  margin-right: 11px;
  color: var(--v3-text-soft);
  font-size: 20px;
}

.login-panel :deep(.el-input__inner) {
  color: var(--v3-text);
  font-size: 14px;
}

.login-panel :deep(.el-input__inner::placeholder) {
  color: var(--v3-muted);
}

.login-panel :deep(.el-input__inner:-webkit-autofill) {
  -webkit-box-shadow: 0 0 0 1000px var(--v3-surface) inset;
  -webkit-text-fill-color: var(--v3-text);
}

.login-panel :deep(.full-button) {
  min-height: 56px;
  margin-top: 4px;
  font-size: 15px;
  font-weight: 700;
}

@media (max-width: 620px) {
  .v2-login-appearance {
    position: static;
    width: 100%;
    margin-bottom: 30px;
    justify-content: space-between;
  }

  .v2-login-status {
    font-size: 12px;
  }
}
</style>
