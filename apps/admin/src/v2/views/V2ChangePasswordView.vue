<template>
  <main class="password-page">
    <section class="password-card" aria-labelledby="password-page-title">
      <div class="password-card__heading">
        <span class="password-card__mark" aria-hidden="true">ID</span>
        <div>
          <h1 id="password-page-title">
            {{ authStore.user?.mustResetPassword ? '首次登录需要修改密码' : '修改密码' }}
          </h1>
          <p>
            {{
              authStore.user?.mustResetPassword
                ? '当前使用的是临时密码，完成修改后才能进入业务系统。'
                : '修改成功后将退出所有设备，请使用新密码重新登录。'
            }}
          </p>
        </div>
      </div>

      <el-alert
        v-if="authStore.user?.mustResetPassword"
        type="warning"
        title="临时密码不能继续用于业务操作"
        description="为保护业务和资金数据，修改密码前系统只允许查看当前身份、修改密码或退出登录。"
        :closable="false"
        show-icon
      />

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        :aria-busy="submitting"
        class="v2-horizontal-form password-form"
        label-position="left"
        label-width="116px"
        require-asterisk-position="right"
        @submit.prevent="submit"
      >
        <el-form-item label="当前密码" prop="currentPassword">
          <el-input
            v-model="form.currentPassword"
            type="password"
            name="current-password"
            autocomplete="current-password"
            maxlength="160"
            placeholder="请输入当前或临时密码"
            show-password
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="form.newPassword"
            type="password"
            name="new-password"
            autocomplete="new-password"
            maxlength="160"
            placeholder="请按系统当前密码策略设置"
            show-password
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            name="confirm-password"
            autocomplete="new-password"
            maxlength="160"
            placeholder="再次输入新密码"
            show-password
          />
        </el-form-item>

        <div v-if="submitError" class="password-form__error" role="alert">
          {{ submitError }}
        </div>

        <div class="password-form__actions">
          <AppButton
            variant="primary"
            native-type="submit"
            :loading="submitting"
            :disabled="submitting || loggingOut"
          >
            修改密码并重新登录
          </AppButton>
          <AppButton
            variant="default"
            :loading="loggingOut"
            :disabled="submitting || loggingOut"
            @click="logout"
          >
            退出登录
          </AppButton>
        </div>
      </el-form>

      <p class="password-card__security">
        密码不会写入日志。修改成功后，所有现有登录会话都会失效。
      </p>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import { getSafeV2Redirect } from '@/v2/router/passwordReset';
import { ElMessage } from '@/v2/services/elementPlusMessage';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const formRef = ref<FormInstance>();
const submitting = ref(false);
const loggingOut = ref(false);
const submitError = ref('');
const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});

const rules: FormRules<typeof form> = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value === form.currentPassword) {
          callback(new Error('新密码不能与当前密码相同'));
          return;
        }
        callback();
      },
      trigger: ['blur', 'change']
    }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        callback(value === form.newPassword ? undefined : new Error('两次输入的新密码不一致'));
      },
      trigger: ['blur', 'change']
    }
  ]
};

async function submit() {
  if (submitting.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  submitError.value = '';
  try {
    const result = await authStore.changePassword(form.currentPassword, form.newPassword);
    if (result.providerSignedOut === false) {
      ElMessage.warning('密码已修改且业务会话已失效；远端会话注销需管理员复核。');
    } else {
      ElMessage.success('密码已修改，请使用新密码重新登录。');
    }
    await router.replace({
      path: '/login',
      query: {
        redirect: getSafeV2Redirect(route.query.redirect)
      }
    });
  } catch (error) {
    submitError.value = getApiErrorMessage(error);
    ElMessage.error(submitError.value);
  } finally {
    submitting.value = false;
  }
}

async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  submitError.value = '';
  try {
    await authStore.logout();
  } catch (error) {
    ElMessage.warning(`${getApiErrorMessage(error)} 本机登录信息已清除。`);
  } finally {
    try {
      await router.replace({
        path: '/login',
        query: {
          redirect: getSafeV2Redirect(route.query.redirect)
        }
      });
    } finally {
      loggingOut.value = false;
    }
  }
}
</script>

<style scoped>
.password-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(
      circle at top left,
      color-mix(in srgb, var(--v3-primary) 12%, transparent),
      transparent 36%
    ),
    var(--v3-bg);
}

.password-card {
  display: grid;
  width: min(100%, 620px);
  gap: 24px;
  padding: clamp(24px, 5vw, 42px);
  border: 1px solid var(--v3-border);
  border-radius: 14px;
  background: var(--v3-surface);
  box-shadow: var(--v3-shadow-lg);
}

.password-card__heading {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.password-card__mark {
  display: grid;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  background: var(--v3-primary);
  color: #fff;
  font-weight: 800;
}

.password-card h1 {
  margin: 0;
  color: var(--v3-text);
  font-size: clamp(22px, 4vw, 28px);
  line-height: 1.25;
}

.password-card__heading p,
.password-card__security {
  margin: 8px 0 0;
  color: var(--v3-text-soft);
  line-height: 1.7;
}

.password-form {
  display: grid;
  gap: 16px;
}

.password-form :deep(.el-form-item) {
  margin: 0;
}

.password-form__error {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--v3-danger) 36%, var(--v3-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--v3-danger) 8%, var(--v3-surface));
  color: var(--v3-danger);
}

.password-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-left: 116px;
}

.password-card__security {
  padding-top: 18px;
  border-top: 1px solid var(--v3-border);
  font-size: 13px;
}

@media (max-width: 560px) {
  .password-page {
    align-items: start;
    padding: 16px;
  }

  .password-card {
    margin-top: 24px;
    padding: 22px 18px;
  }

  .password-form :deep(.el-form-item__label) {
    width: 96px !important;
  }

  .password-form__actions {
    padding-left: 96px;
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
