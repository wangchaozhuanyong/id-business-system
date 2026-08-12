<template>
  <section class="v2-branding-overview" aria-label="品牌设置总览">
    <div class="v2-branding-overview__identity">
      <V2BrandLogo
        class="v2-branding-overview__mark"
        :logo-url="form.logoUrl || V2_BRANDING_DEFAULTS.logoUrl"
        :logo-text="form.logoText || V2_BRANDING_DEFAULTS.logoText"
      />
      <div class="v2-branding-overview__intro">
        <span>品牌管理</span>
        <h2>{{ form.appName || V2_BRANDING_DEFAULTS.appName }}</h2>
        <p>统一管理后台标识、登录内容与浏览器标题。</p>
      </div>
    </div>

    <div class="v2-branding-overview__metrics" aria-label="当前品牌配置状态">
      <article>
        <span>品牌副标题</span>
        <strong>{{ form.appSubtitle || V2_BRANDING_DEFAULTS.appSubtitle }}</strong>
        <small>后台与登录页共用</small>
      </article>
      <article>
        <span>登录标题</span>
        <strong>{{ heroLineCount }} 行</strong>
        <small>最多支持 3 行</small>
      </article>
      <article>
        <span>发布状态</span>
        <strong>{{ hasUnsavedChanges ? '待保存' : '已同步' }}</strong>
        <small>{{ updatedAtText ? `最近保存 ${updatedAtText}` : '等待首次加载' }}</small>
      </article>
    </div>

    <div class="v2-branding-overview__actions">
      <el-tag effect="plain" type="info">管理员设置</el-tag>
      <AppButton variant="ghost" :disabled="saving" @click="$emit('reset-defaults')">
        <el-icon><RefreshLeft /></el-icon>
        恢复默认
      </AppButton>
      <AppButton variant="primary" :loading="saving" :disabled="saving" @click="$emit('save')">
        <el-icon><Check /></el-icon>
        保存设置
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Check, RefreshLeft } from '@element-plus/icons-vue';
import { V2_BRANDING_DEFAULTS, type UpdateV2BrandingSettingsInput } from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';

defineProps<{
  form: UpdateV2BrandingSettingsInput;
  heroLineCount: number;
  hasUnsavedChanges: boolean;
  saving: boolean;
  updatedAtText: string;
}>();

defineEmits<{
  'reset-defaults': [];
  save: [];
}>();
</script>
