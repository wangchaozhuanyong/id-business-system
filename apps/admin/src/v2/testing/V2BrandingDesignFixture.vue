<template>
  <div class="v2-shell v2-branding-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
        </div>
      </div>

      <nav class="v2-navigation" aria-label="设计验收导航">
        <section
          v-for="section in navigation"
          :key="section.title"
          class="v2-navigation__section"
          :class="{ 'is-open': section.active, 'is-active': section.active }"
        >
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><component :is="section.icon" /></el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#branding">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">品牌设置</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>品牌设置</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-branding-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-branding-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-branding-page">
            <V2BrandingOverview
              :form="form"
              :hero-line-count="previewHeroLines.length"
              :has-unsaved-changes="hasUnsavedChanges"
              :saving="saving"
              updated-at-text="08/10 16:20"
              @reset-defaults="resetDefaults"
              @save="save"
            />

            <div class="v2-branding-workspace">
              <el-form
                :model="form"
                class="v2-horizontal-form v2-branding-editor"
                label-position="left"
                label-width="150px"
                require-asterisk-position="right"
                @submit.prevent="save"
              >
                <header class="v2-branding-editor__heading">
                  <div><span>品牌配置</span><strong>发布内容</strong></div>
                  <el-tag effect="plain" type="info">公开登录页读取</el-tag>
                </header>

                <section
                  class="v2-branding-editor__section"
                  aria-labelledby="fixture-identity-title"
                >
                  <div class="v2-branding-editor__section-heading">
                    <div><span>01</span><strong id="fixture-identity-title">品牌识别</strong></div>
                    <small>4 项</small>
                  </div>
                  <div class="v2-branding-editor__fields">
                    <el-form-item label="软件名称" required>
                      <el-input
                        v-model="form.appName"
                        :maxlength="V2_BRANDING_LIMITS.appName"
                        show-word-limit
                      />
                    </el-form-item>
                    <el-form-item label="Logo 文字" required>
                      <el-input
                        v-model="form.logoText"
                        :maxlength="V2_BRANDING_LIMITS.logoText"
                        show-word-limit
                      />
                    </el-form-item>
                    <el-form-item label="Logo 图片地址" required>
                      <el-input
                        v-model="form.logoUrl"
                        :maxlength="V2_BRANDING_LIMITS.logoUrl"
                        show-word-limit
                      />
                    </el-form-item>
                    <el-form-item label="品牌副标题" required>
                      <el-input
                        v-model="form.appSubtitle"
                        :maxlength="V2_BRANDING_LIMITS.appSubtitle"
                        show-word-limit
                      />
                    </el-form-item>
                  </div>
                </section>

                <section class="v2-branding-editor__section" aria-labelledby="fixture-login-title">
                  <div class="v2-branding-editor__section-heading">
                    <div><span>02</span><strong id="fixture-login-title">登录内容</strong></div>
                    <small>3 项</small>
                  </div>
                  <div class="v2-branding-editor__fields">
                    <el-form-item label="登录主标题" required>
                      <el-input
                        v-model="form.loginHeroTitle"
                        type="textarea"
                        :rows="3"
                        :maxlength="V2_BRANDING_LIMITS.loginHeroTitle"
                        show-word-limit
                      />
                    </el-form-item>
                    <el-form-item label="登录说明" required>
                      <el-input
                        v-model="form.loginNote"
                        type="textarea"
                        :rows="2"
                        :maxlength="V2_BRANDING_LIMITS.loginNote"
                        show-word-limit
                      />
                    </el-form-item>
                    <el-form-item label="登录页脚" required>
                      <el-input
                        v-model="form.footerText"
                        :maxlength="V2_BRANDING_LIMITS.footerText"
                        show-word-limit
                      />
                    </el-form-item>
                  </div>
                </section>

                <section
                  class="v2-branding-editor__section"
                  aria-labelledby="fixture-browser-title"
                >
                  <div class="v2-branding-editor__section-heading">
                    <div><span>03</span><strong id="fixture-browser-title">浏览器信息</strong></div>
                    <small>1 项</small>
                  </div>
                  <div class="v2-branding-editor__fields">
                    <el-form-item label="浏览器标题后缀" required>
                      <el-input
                        v-model="form.documentTitleSuffix"
                        :maxlength="V2_BRANDING_LIMITS.documentTitleSuffix"
                        show-word-limit
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
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Setting,
  User
} from '@element-plus/icons-vue';
import {
  V2_BRANDING_DEFAULTS,
  V2_BRANDING_LIMITS,
  splitV2BrandingHeroTitle,
  type UpdateV2BrandingSettingsInput
} from '@apple-business/shared';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2BrandingOverview from '@/v2/features/branding/components/V2BrandingOverview.vue';
import V2BrandingPreview from '@/v2/features/branding/components/V2BrandingPreview.vue';

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];

const savedForm = reactive<UpdateV2BrandingSettingsInput>({
  ...V2_BRANDING_DEFAULTS,
  appName: 'ID 业务管理系统',
  logoText: 'ID',
  appSubtitle: '跨币种订阅业务工作台',
  documentTitleSuffix: 'ID 业务管理',
  loginHeroTitle: '把订单、余额与续费\n收进一条安全动线',
  loginNote: '使用员工账号登录，所有敏感资料访问均会记录审计。',
  footerText: '© 2026 内部系统 · 仅限授权人员访问'
});
const form = reactive<UpdateV2BrandingSettingsInput>({ ...savedForm });
const previewHeroLines = computed(() => splitV2BrandingHeroTitle(form.loginHeroTitle));
const hasUnsavedChanges = computed(() =>
  Object.keys(savedForm).some((key) => {
    const field = key as keyof UpdateV2BrandingSettingsInput;
    return form[field] !== savedForm[field];
  })
);
const saving = ref(false);
const notice = ref('');

function resetDefaults() {
  Object.assign(form, V2_BRANDING_DEFAULTS);
  notice.value = '已恢复默认内容，尚未保存。';
}

function save() {
  saving.value = true;
  window.setTimeout(() => {
    Object.assign(savedForm, form);
    saving.value = false;
    notice.value = '品牌设置已保存。';
  }, 180);
}
</script>

<style scoped>
.v2-branding-fixture-avatar {
  display: inline-grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: #eaf1ff;
  color: #194ea8;
  font-size: 12px;
  font-weight: 700;
}

.v2-branding-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
