<template>
  <section class="v2-records-page v2-branding-page">
    <V2BrandingOverview
      :form="form"
      :hero-line-count="previewHeroLines.length"
      :has-unsaved-changes="hasUnsavedChanges"
      :saving="saving"
      :updated-at-text="updatedAtText"
      @reset-defaults="resetDefaults"
      @save="submit"
    />

    <V2AsyncRegion
      skeleton="settings"
      :phase="queryPhase"
      :previous-data="isParameterTransition"
      :error="errorMessage"
      loading-title="正在加载品牌设置"
      refreshing-title="正在更新品牌设置"
      error-title="品牌设置加载失败"
      @retry="refresh"
    >
      <div class="v2-branding-workspace">
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          class="v2-horizontal-form v2-branding-editor"
          label-position="left"
          label-width="150px"
          require-asterisk-position="right"
          @submit.prevent="submit"
        >
          <div class="v2-branding-editor__heading">
            <div>
              <span>品牌配置</span>
              <strong>发布内容</strong>
            </div>
            <el-tag effect="plain" type="info">公开登录页读取</el-tag>
          </div>

          <section class="v2-branding-editor__section" aria-labelledby="branding-identity-title">
            <div class="v2-branding-editor__section-heading">
              <div>
                <span>01</span>
                <strong id="branding-identity-title">品牌识别</strong>
              </div>
              <small>4 项</small>
            </div>

            <div class="v2-branding-editor__fields">
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
            </div>
          </section>

          <section class="v2-branding-editor__section" aria-labelledby="branding-login-title">
            <div class="v2-branding-editor__section-heading">
              <div>
                <span>02</span>
                <strong id="branding-login-title">登录内容</strong>
              </div>
              <small>3 项</small>
            </div>

            <div class="v2-branding-editor__fields">
              <el-form-item prop="loginHeroTitle">
                <template #label>登录主标题</template>
                <el-input
                  v-model="form.loginHeroTitle"
                  type="textarea"
                  :rows="3"
                  :maxlength="V2_BRANDING_LIMITS.loginHeroTitle"
                  show-word-limit
                  placeholder="支持换行，最多 3 行"
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
            </div>
          </section>

          <section class="v2-branding-editor__section" aria-labelledby="branding-browser-title">
            <div class="v2-branding-editor__section-heading">
              <div>
                <span>03</span>
                <strong id="branding-browser-title">浏览器信息</strong>
              </div>
              <small>1 项</small>
            </div>

            <div class="v2-branding-editor__fields">
              <el-form-item prop="documentTitleSuffix">
                <template #label>浏览器标题后缀</template>
                <el-input
                  v-model.trim="form.documentTitleSuffix"
                  :maxlength="V2_BRANDING_LIMITS.documentTitleSuffix"
                  show-word-limit
                  placeholder="例如：ID 业务管理"
                />
              </el-form-item>
            </div>
          </section>

          <footer class="v2-branding-editor__status" role="status">
            <span :class="{ 'is-pending': hasUnsavedChanges }" aria-hidden="true" />
            <strong>{{ hasUnsavedChanges ? '更改尚未保存' : '配置已与服务器同步' }}</strong>
          </footer>
        </el-form>

        <V2BrandingPreview :form="form" :hero-lines="previewHeroLines" />
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
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { setV2Branding } from '@/v2/composables/useV2Branding';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2BrandingApi } from './api';
import V2BrandingOverview from './components/V2BrandingOverview.vue';
import V2BrandingPreview from './components/V2BrandingPreview.vue';
import '@/v2/styles/records.css';
import '@/v2/styles/branding.css';

const formRef = ref<FormInstance>();
const saving = ref(false);
const form = reactive<UpdateV2BrandingSettingsInput>({ ...V2_BRANDING_DEFAULTS });
const brandingQuery = useV2ModuleQuery<V2BrandingSettings>({
  moduleKey: 'branding',
  scope: 'branding',
  key: 'settings',
  query: ({ signal }) => idBusinessV2BrandingApi.get({ signal })
});

const queryPhase = brandingQuery.phase;
const isParameterTransition = brandingQuery.isParameterTransition;
const errorMessage = computed(() =>
  brandingQuery.error.value ? getApiErrorMessage(brandingQuery.error.value) : ''
);
const updatedAtText = computed(() => formatDate(brandingQuery.data.value?.updatedAt));
const previewHeroLines = computed(() => splitV2BrandingHeroTitle(form.loginHeroTitle));
const hasUnsavedChanges = computed(() => {
  const settings = brandingQuery.data.value;
  if (!settings) return false;
  const savedForm = toFormInput(settings);
  return Object.keys(savedForm).some((key) => {
    const field = key as keyof UpdateV2BrandingSettingsInput;
    return form[field] !== savedForm[field];
  });
});
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
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}
</script>
