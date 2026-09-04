<template>
  <el-drawer
    class="v2-mail-viewer-drawer"
    :model-value="modelValue"
    title="邮箱查询与管理"
    size="min(1220px, 100vw)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    @close="$emit('update:modelValue', false)"
  >
    <template #header="{ titleId, titleClass }">
      <div class="v2-mail-viewer-drawer__heading">
        <span :id="titleId" :class="titleClass">邮箱查询与管理</span>
        <FeatureHelp
          title="邮箱查询与管理说明"
          :text="mailViewerHelp"
          placement="bottom"
          :width="380"
        />
      </div>
    </template>
    <div class="v2-mail-viewer-drawer__body">
      <div class="v2-mail-viewer-drawer__public-link">
        <span>买家查询页</span>
        <AppButton size="small" variant="soft" @click="openPublicMailbox">
          <el-icon><TopRight /></el-icon>
          打开查询页
        </AppButton>
      </div>

      <el-tabs v-model="activeTab" class="v2-mail-viewer-tabs">
        <el-tab-pane label="邮件查询" name="query">
          <V2MailQueryPanel />
        </el-tab-pane>
        <el-tab-pane v-if="isAdmin" label="邮箱池管理" name="manage">
          <V2ManagedMailboxPanel />
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { TopRight } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import { useAuthStore } from '@/stores/auth';
import V2ManagedMailboxPanel from './V2ManagedMailboxPanel.vue';
import V2MailQueryPanel from './V2MailQueryPanel.vue';

defineProps<{ modelValue: boolean }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();

const authStore = useAuthStore();
const isAdmin = computed(() => authStore.user?.roles.includes('admin') === true);
const activeTab = ref<'query' | 'manage'>('query');
const mailViewerHelp = [
  '查询由本系统验证，并直接读取已授权的谷歌、苹果或微软邮箱。',
  '买家查询码与邮箱应用专用密码相互独立。',
  '邮件正文只在本次请求中返回，不写入服务器数据库或浏览器持久缓存。'
];

function openPublicMailbox() {
  const opened = window.open('/mailbox', '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}
</script>

<style>
.v2-mail-viewer-drawer .el-drawer__body {
  padding: 0;
}

.v2-mail-viewer-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--v2-border);
}

.v2-mail-viewer-drawer__body {
  display: grid;
  min-width: 0;
  gap: 0;
  padding: 8px 20px 18px;
}

.v2-mail-viewer-drawer__heading {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.v2-mail-viewer-tabs {
  min-width: 0;
}

.v2-mail-viewer-drawer__public-link {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0 8px;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mail-viewer-tabs > .el-tabs__content {
  overflow: visible;
  padding-top: 0;
}

@media (max-width: 560px) {
  .v2-mail-viewer-drawer__body {
    padding: 8px 14px 16px;
  }

  .v2-mail-viewer-tabs > .el-tabs__header .el-tabs__item {
    padding: 0 10px;
    font-size: 12px;
  }
}
</style>
