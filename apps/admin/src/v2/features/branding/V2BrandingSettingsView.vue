<template>
  <section class="v2-branding-page">
    <V2PageContext
      description="配置后台左上角品牌、默认 Logo、登录页主标题和浏览器标题。未保存前只影响右侧预览，保存后登录页立即使用新设置。"
      aria-label="品牌设置说明"
    >
      <template #meta>
        <el-tag effect="plain" type="info">公开登录页读取</el-tag>
        <span v-if="updatedAtText">最近保存：{{ updatedAtText }}</span>
      </template>
      <template #actions>
        <AppButton size="small" variant="soft" :disabled="saving" @click="resetDefaults">
          恢复默认设置
        </AppButton>
        <AppButton
          size="small"
          variant="primary"
          :loading="saving"
          :disabled="saving"
          @click="submit"
        >
          保存设置
        </AppButton>
      </template>
    </V2PageContext>

    <V2AsyncRegion
      skeleton="settings"
      :loading="loading"
      :resolved="resolved"
      :error="errorMessage"
      loading-title="正在加载品牌设置"
      refreshing-title="正在更新品牌设置"
      error-title="品牌设置加载失败"
      @retry="refresh"
    >
      <div class="v2-branding-grid">
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          class="v2-horizontal-form v2-branding-form"
          label-position="left"
          label-width="168px"
          require-asterisk-position="right"
          @submit.prevent="submit"
        >
          <el-form-item prop="appName">
            <template #label>软件名称</template>
            <el-input
              v-model.trim="form.appName"
              :maxlength="V2_BRANDING_LIMITS.appName"
              show-word-limit
              placeholder="例如：ID 业务管理"
            />
          </el-form-item>

          <el-form-item prop="logoText">
            <template #label>Logo 文字</template>
            <el-input
              v-model.trim="form.logoText"
              :maxlength="V2_BRANDING_LIMITS.logoText"
              show-word-limit
              placeholder="例如：ID"
            />
          </el-form-item>

          <el-form-item prop="logoUrl">
            <template #label>Logo 图片地址</template>
            <el-input
              v-model.trim="form.logoUrl"
              :maxlength="V2_BRANDING_LIMITS.logoUrl"
              show-word-limit
              placeholder="/brand/default-logo.svg"
            />
          </el-form-item>

          <el-form-item prop="appSubtitle">
            <template #label>品牌副标题</template>
            <el-input
              v-model.trim="form.appSubtitle"
              :maxlength="V2_BRANDING_LIMITS.appSubtitle"
              show-word-limit
              placeholder="例如：Apple ID 订阅运营"
            />
          </el-form-item>

          <el-form-item prop="documentTitleSuffix">
            <template #label>浏览器标题后缀</template>
            <el-input
              v-model.trim="form.documentTitleSuffix"
              :maxlength="V2_BRANDING_LIMITS.documentTitleSuffix"
              show-word-limit
              placeholder="例如：ID 业务管理"
            />
          </el-form-item>

          <el-form-item prop="loginHeroTitle">
            <template #label>登录主标题</template>
            <el-input
              v-model="form.loginHeroTitle"
              type="textarea"
              :rows="3"
              :maxlength="V2_BRANDING_LIMITS.loginHeroTitle"
              show-word-limit
              placeholder="支持换行，建议 2 行"
            />
          </el-form-item>

          <el-form-item prop="loginNote">
            <template #label>登录说明</template>
            <el-input
              v-model="form.loginNote"
              type="textarea"
              :rows="2"
              :maxlength="V2_BRANDING_LIMITS.loginNote"
              show-word-limit
              placeholder="显示在登录表单标题下方"
            />
          </el-form-item>

          <el-form-item prop="footerText">
            <template #label>登录页脚</template>
            <el-input
              v-model.trim="form.footerText"
              :maxlength="V2_BRANDING_LIMITS.footerText"
              show-word-limit
              placeholder="例如：© 2026 内部系统 · 仅限授权人员访问"
            />
          </el-form-item>
        </el-form>

        <aside class="v2-branding-preview" aria-label="品牌预览">
          <span class="v2-branding-preview__label">登录页预览</span>
          <div class="v2-branding-preview__brand">
            <V2BrandLogo
              :logo-url="form.logoUrl || V2_BRANDING_DEFAULTS.logoUrl"
              :logo-text="form.logoText || V2_BRANDING_DEFAULTS.logoText"
            />
            <div>
              <strong>{{ form.appName || V2_BRANDING_DEFAULTS.appName }}</strong>
              <small>{{ form.appSubtitle || V2_BRANDING_DEFAULTS.appSubtitle }}</small>
            </div>
          </div>
          <h2>
            <template v-for="(line, index) in previewHeroLines" :key="`${index}-${line}`">
              {{ line }}<br v-if="index < previewHeroLines.length - 1" />
            </template>
          </h2>
          <p>{{ form.loginNote || V2_BRANDING_DEFAULTS.loginNote }}</p>
          <footer>{{ form.footerText || V2_BRANDING_DEFAULTS.footerText }}</footer>
          <div class="v2-branding-preview__browser">
            登录 - {{ form.documentTitleSuffix || V2_BRANDING_DEFAULTS.documentTitleSuffix }}
          </div>
        </aside>
      </div>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { computed, reactive, ref, watch } from 'vue';
import {
  V2_BRANDING_DEFAULTS,
  V2_BRANDING_LIMITS,
  splitV2BrandingHeroTitle,
  type UpdateV2BrandingSettingsInput,
  type V2BrandingSettings
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { setV2Branding } from '@/v2/composables/useV2Branding';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2BrandingApi } from './api';

const formRef = ref<FormInstance>();
const saving = ref(false);
const form = reactive<UpdateV2BrandingSettingsInput>({ ...V2_BRANDING_DEFAULTS });
const brandingQuery = useV2ModuleQuery<V2BrandingSettings>({
  moduleKey: 'branding',
  scope: 'branding',
  key: 'settings',
  query: ({ signal }) => idBusinessV2BrandingApi.get({ signal })
});

const loading = computed(
  () => brandingQuery.isInitialLoading.value || brandingQuery.isRefreshing.value
);
const resolved = computed(() => brandingQuery.hasData.value);
const errorMessage = computed(() =>
  brandingQuery.error.value ? getApiErrorMessage(brandingQuery.error.value) : ''
);
const updatedAtText = computed(() => formatDate(brandingQuery.data.value?.updatedAt));
const previewHeroLines = computed(() => splitV2BrandingHeroTitle(form.loginHeroTitle));
const rules: FormRules<typeof form> = {
  appName: [requiredRule('请填写软件名称'), maxRule(V2_BRANDING_LIMITS.appName)],
  logoText: [requiredRule('请填写 Logo 文字'), maxRule(V2_BRANDING_LIMITS.logoText)],
  logoUrl: [
    requiredRule('请填写 Logo 图片地址'),
    maxRule(V2_BRANDING_LIMITS.logoUrl),
    {
      validator: (_rule, value, callback) => {
        const text = String(value ?? '').trim();
        if ((text.startsWith('/') && !text.startsWith('//')) || /^https?:\/\/[^\s]+$/i.test(text)) {
          callback();
        } else {
          callback(new Error('Logo 图片地址必须是站内路径或 http(s) 链接'));
        }
      },
      trigger: 'blur'
    }
  ],
  appSubtitle: [requiredRule('请填写品牌副标题'), maxRule(V2_BRANDING_LIMITS.appSubtitle)],
  documentTitleSuffix: [
    requiredRule('请填写浏览器标题后缀'),
    maxRule(V2_BRANDING_LIMITS.documentTitleSuffix)
  ],
  loginHeroTitle: [
    requiredRule('请填写登录主标题'),
    maxRule(V2_BRANDING_LIMITS.loginHeroTitle),
    {
      validator: (_rule, value, callback) => {
        const lines = String(value ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 3) callback(new Error('登录主标题最多 3 行'));
        else callback();
      },
      trigger: 'blur'
    }
  ],
  loginNote: [requiredRule('请填写登录说明'), maxRule(V2_BRANDING_LIMITS.loginNote)],
  footerText: [requiredRule('请填写登录页脚'), maxRule(V2_BRANDING_LIMITS.footerText)]
};

watch(
  () => brandingQuery.data.value,
  (settings) => {
    if (!settings) return;
    Object.assign(form, toFormInput(settings));
    setV2Branding(settings);
  },
  { immediate: true }
);

async function submit() {
  if (saving.value || !(await validateV2Form(formRef.value))) return;
  saving.value = true;
  try {
    const settings = await idBusinessV2BrandingApi.update({ ...form });
    Object.assign(form, toFormInput(settings));
    setV2Branding(settings);
    ElMessage.success('品牌与登录页设置已保存');
    void brandingQuery.refresh();
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    saving.value = false;
  }
}

function resetDefaults() {
  Object.assign(form, V2_BRANDING_DEFAULTS);
}

function refresh() {
  void brandingQuery.refresh();
}

function toFormInput(settings: V2BrandingSettings): UpdateV2BrandingSettingsInput {
  return {
    appName: settings.appName,
    logoText: settings.logoText,
    logoUrl: settings.logoUrl,
    appSubtitle: settings.appSubtitle,
    loginHeroTitle: settings.loginHeroTitle,
    loginNote: settings.loginNote,
    footerText: settings.footerText,
    documentTitleSuffix: settings.documentTitleSuffix
  };
}

function requiredRule(message: string) {
  return { required: true, whitespace: true, message, trigger: 'blur' } as const;
}

function maxRule(max: number) {
  return { max, message: `不能超过 ${max} 个字符`, trigger: 'blur' } as const;
}

function formatDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}
</script>

<style scoped>
.v2-branding-page {
  display: grid;
  gap: 16px;
}

.v2-branding-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 16px;
  align-items: start;
}

.v2-branding-form,
.v2-branding-preview {
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
  box-shadow: var(--v2-shadow-card);
}

.v2-branding-form {
  padding: 18px;
}

.v2-branding-preview {
  position: sticky;
  top: 16px;
  overflow: hidden;
  display: grid;
  gap: 16px;
  padding: 20px;
}

.v2-branding-preview::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at top left, rgb(56 189 248 / 18%), transparent 34%),
    radial-gradient(circle at bottom right, rgb(99 102 241 / 16%), transparent 32%);
  pointer-events: none;
}

.v2-branding-preview > * {
  position: relative;
}

.v2-branding-preview__label {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-branding-preview__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.v2-branding-preview__brand > span {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 15px;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: white;
  font-weight: 800;
}

.v2-branding-preview__brand div {
  display: grid;
  gap: 3px;
}

.v2-branding-preview__brand small,
.v2-branding-preview p,
.v2-branding-preview footer {
  color: var(--v2-text-soft);
}

.v2-branding-preview h2 {
  margin: 0;
  color: var(--v2-text);
  font-size: clamp(26px, 3vw, 34px);
  line-height: 1.08;
  letter-spacing: -0.04em;
}

.v2-branding-preview p,
.v2-branding-preview footer {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.v2-branding-preview__browser {
  border: 1px solid var(--v2-border);
  border-radius: 999px;
  padding: 8px 12px;
  color: var(--v2-text-soft);
  font-size: 12px;
  background: rgb(255 255 255 / 58%);
}

@media (max-width: 980px) {
  .v2-branding-grid {
    grid-template-columns: 1fr;
  }

  .v2-branding-preview {
    position: static;
  }
}

@media (max-width: 700px) {
  .v2-branding-form {
    padding: 14px;
  }
}
</style>
