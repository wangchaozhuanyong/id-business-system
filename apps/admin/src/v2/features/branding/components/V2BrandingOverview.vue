<template>
  <V2PageOverview
    class="v2-branding-overview"
    aria-label="品牌设置总览"
    :title="form.appName || V2_BRANDING_DEFAULTS.appName"
    help="统一管理后台标识、登录内容与浏览器标题。"
    metrics-label="当前品牌配置状态"
    :columns="3"
  >
    <template #identity
      ><V2BrandLogo
        class="v2-branding-overview__mark"
        :logo-url="form.logoUrl || V2_BRANDING_DEFAULTS.logoUrl"
        :logo-text="form.logoText || V2_BRANDING_DEFAULTS.logoText"
    /></template>
    <template #metrics>
      <V2OverviewMetric
        label="品牌副标题"
        :value="form.appSubtitle || V2_BRANDING_DEFAULTS.appSubtitle"
        note="后台与登录页共用"
      />
      <V2OverviewMetric label="登录标题" :value="heroLineCount + ' 行'" note="最多支持 3 行" />
      <V2OverviewMetric
        label="发布状态"
        :value="hasUnsavedChanges ? '待保存' : '已同步'"
        :note="updatedAtText ? `最近保存 ${updatedAtText}` : '等待首次加载'"
      />
    </template>
    <template #actions>
      <el-tag effect="plain" type="info">管理员设置</el-tag>
      <AppButton variant="ghost" :disabled="saving" @click="$emit('reset-defaults')">
        <el-icon><RefreshLeft /></el-icon>
        恢复默认
      </AppButton>
      <AppButton variant="primary" :loading="saving" :disabled="saving" @click="$emit('save')">
        <el-icon><Check /></el-icon>
        保存设置
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
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
