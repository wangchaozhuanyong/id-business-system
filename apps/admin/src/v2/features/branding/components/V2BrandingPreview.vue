<template>
  <aside class="v2-branding-preview" aria-label="品牌实时预览">
    <header class="v2-branding-preview__heading">
      <div>
        <span>实时预览</span>
        <strong>登录页与浏览器标题</strong>
      </div>
      <el-tag effect="plain" type="info">未保存预览</el-tag>
    </header>

    <div class="v2-branding-preview__window">
      <div class="v2-branding-preview__browser-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <small>
          登录 - {{ form.documentTitleSuffix || V2_BRANDING_DEFAULTS.documentTitleSuffix }}
        </small>
      </div>

      <div class="v2-branding-preview__stage">
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

        <div class="v2-branding-preview__login-copy">
          <h3>
            <template v-for="(line, index) in heroLines" :key="`${index}-${line}`">
              {{ line }}<br v-if="index < heroLines.length - 1" />
            </template>
          </h3>
          <p>{{ form.loginNote || V2_BRANDING_DEFAULTS.loginNote }}</p>
        </div>

        <div class="v2-branding-preview__login-panel" aria-hidden="true">
          <span>账号</span>
          <i />
          <span>密码</span>
          <i />
          <b>登录</b>
        </div>

        <footer>{{ form.footerText || V2_BRANDING_DEFAULTS.footerText }}</footer>
      </div>
    </div>

    <p class="v2-branding-preview__hint">输入内容会立即反映在预览中，保存后才会正式发布。</p>
  </aside>
</template>

<script setup lang="ts">
import { V2_BRANDING_DEFAULTS, type UpdateV2BrandingSettingsInput } from '@apple-business/shared';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';

defineProps<{
  form: UpdateV2BrandingSettingsInput;
  heroLines: string[];
}>();
</script>
