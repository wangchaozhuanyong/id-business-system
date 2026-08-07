<template>
  <main class="login-page">
    <section class="login-canvas" aria-label="系统登录">
      <div class="login-brand">
        <V2BrandLogo
          class="login-brand__mark"
          :logo-url="branding.logoUrl"
          :logo-text="branding.logoText"
        />
        <div>
          <strong>{{ branding.appName }}</strong>
          <span>{{ branding.appSubtitle }}</span>
        </div>
      </div>

      <div class="login-shell">
        <section class="login-showcase" aria-label="登录页说明">
          <div class="login-showcase__content">
            <h1>
              <template v-for="(line, index) in heroTitleLines" :key="`${index}-${line}`">
                {{ line }}<br v-if="index < heroTitleLines.length - 1" />
              </template>
            </h1>
          </div>

          <div class="login-workflow" aria-label="登录后处理流程">
            <span>订单接入</span>
            <i />
            <span>余额核对</span>
            <i />
            <span>续费排程</span>
            <i />
            <span>财务留痕</span>
          </div>
        </section>

        <section class="login-panel" aria-label="登录表单">
          <div class="login-panel__card">
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
            <el-form
              id="v2-admin-login-form"
              ref="formRef"
              :model="form"
              :rules="rules"
              :aria-busy="loading"
              :aria-describedby="loginError ? 'v2-login-error-message' : undefined"
              class="v2-horizontal-form v2-login-form"
              label-position="left"
              label-width="120px"
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
                <template #label>验证码</template>
                <el-input
                  v-model.trim="form.mfaCode"
                  autocomplete="one-time-code"
                  inputmode="numeric"
                  maxlength="64"
                  name="one-time-code"
                  placeholder="可选 MFA 或恢复码"
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
                进入运营后台
              </AppButton>
            </el-form>
          </div>
        </section>

        <div class="login-mobile-ground" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>

        <p class="login-showcase__footer">{{ branding.footerText }}</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { Key, Lock, Sunny, User } from '@element-plus/icons-vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getApiErrorMessage, http, request } from '@/api/client';
import { isApiError } from '@/api/apiError';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import { getSafeV2Redirect } from '@/v2/router/passwordReset';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { getPreferredV2Theme, persistV2Theme, type V2Theme } from '@/v2/theme';
import { useV2Branding } from '@/v2/composables/useV2Branding';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { branding, heroTitleLines, loadBranding } = useV2Branding();
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
    await navigateSafely(router, getLoginRedirectPath());
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
  if (isApiError(error) && (error.code === 'AUTH_INVALID' || error.status === 401)) {
    return '账号、密码或动态验证码不正确，请检查后重试。';
  }
  return getApiErrorMessage(error);
}

watch(
  () => [form.username, form.password, form.mfaCode],
  () => {
    loginError.value = '';
  }
);

onMounted(() => {
  void loadBranding().catch(() => undefined);
  void checkSystemHealth();
});
</script>

<style scoped>
.v2-login-appearance {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 18px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--v3-border) 72%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--v3-surface-2) 78%, var(--v3-surface));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 50%, transparent);
  color: var(--v3-text);
}

.v2-login-theme {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;
  color: var(--v3-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
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
  min-width: 0;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--v3-success-soft) 72%, var(--v3-surface));
  color: var(--v3-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
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

.login-panel :deep(.el-form) {
  display: grid;
  gap: 18px;
}

.login-panel :deep(.el-form-item) {
  align-items: center;
  margin: 0;
}

.login-panel :deep(.el-form-item__label) {
  width: 120px !important;
  height: auto;
  margin: 0;
  padding: 0 18px 0 0;
  color: var(--v3-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.login-panel :deep(.el-input__wrapper) {
  min-height: 56px;
  padding: 0 16px;
  border: 1px solid var(--v3-border);
  border-radius: 16px;
  background: var(--v3-surface);
  box-shadow: none;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease,
    background-color 180ms ease;
}

.login-panel :deep(.el-input__wrapper:hover) {
  border-color: var(--v3-muted);
  box-shadow: none;
}

.login-panel :deep(.el-input__wrapper.is-focus) {
  border-color: var(--v3-primary);
  box-shadow: var(--v3-focus-ring);
  transform: translateY(-1px);
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
  margin-top: 2px;
  border-radius: 18px;
  font-size: 15px;
  font-weight: 700;
  transition:
    transform 180ms ease,
    box-shadow 180ms ease,
    background-color 180ms ease;
}

.login-panel :deep(.full-button:active) {
  transform: translateY(1px) scale(0.99);
}

@media (max-width: 620px) {
  .v2-login-appearance {
    gap: 12px;
    margin-bottom: 16px;
    padding: 9px 10px;
    border-radius: 16px;
  }

  .v2-login-status {
    font-size: 12px;
  }

  .v2-login-theme {
    gap: 8px;
  }

  .v2-login-theme span {
    font-size: 12px;
  }

  .login-panel :deep(.el-form) {
    gap: 17px;
  }

  .login-panel :deep(.el-form-item) {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    align-items: start;
    column-gap: 10px;
  }

  .login-panel :deep(.el-form-item__label) {
    width: 76px !important;
    min-height: 50px;
    margin: 0;
    padding: 14px 0 0;
    color: var(--v3-text-soft);
    font-size: 13px;
    line-height: 1.35;
  }

  .login-panel :deep(.el-form-item__content) {
    min-width: 0;
  }

  .login-panel :deep(.el-input__wrapper) {
    min-height: 50px;
    padding: 0 13px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--v3-surface) 88%, var(--color-bg));
  }

  .login-panel :deep(.el-input__prefix) {
    margin-right: 8px;
    font-size: 18px;
  }

  .login-panel :deep(.full-button) {
    min-height: 52px;
    border-radius: 16px;
  }
}

@media (max-width: 430px) {
  .v2-login-appearance {
    gap: 10px;
  }

  .v2-login-status {
    margin-left: auto;
  }
}

@media (max-width: 360px) {
  .login-panel :deep(.el-form-item) {
    grid-template-columns: 66px minmax(0, 1fr);
    column-gap: 8px;
  }

  .login-panel :deep(.el-form-item__label) {
    width: 66px !important;
    font-size: 12px;
  }
}
</style>
