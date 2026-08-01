<template>
  <section class="v2-records-page v2-profile-page">
    <div class="v2-profile-page__refresh">
      <span>个人资料只读并默认脱敏；安全操作均作用于当前登录账号。</span>
      <AppButton icon-only title="刷新账户信息" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
      </AppButton>
    </div>

    <V2AsyncRegion
      skeleton="settings"
      :loading="page.loading"
      :resolved="page.resolved"
      :error="page.error"
      loading-title="正在加载我的账户"
      refreshing-title="正在更新账户安全状态"
      error-title="我的账户加载失败"
      @retry="page.refresh"
    >
      <div class="v2-profile-page__content">
        <V2ProfileOverview :page="page" />
        <V2ProfileSessionsPanel :page="page" />
      </div>
    </V2AsyncRegion>

    <V2ProfileMfaDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ProfileMfaDialogs from './components/V2ProfileMfaDialogs.vue';
import V2ProfileOverview from './components/V2ProfileOverview.vue';
import V2ProfileSessionsPanel from './components/V2ProfileSessionsPanel.vue';
import { useProfilePage } from './useProfilePage';
import '@/v2/styles/records.css';

const page = reactive(useProfilePage());
</script>

<style scoped>
.v2-profile-page__refresh {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-profile-page__refresh span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-profile-page__content {
  display: grid;
  min-width: 0;
  gap: 18px;
}
</style>
