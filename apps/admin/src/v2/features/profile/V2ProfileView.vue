<template>
  <section class="v2-records-page v2-profile-page">
    <V2AsyncRegion
      skeleton="settings"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
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
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ProfileMfaDialogs from './components/V2ProfileMfaDialogs.vue';
import V2ProfileOverview from './components/V2ProfileOverview.vue';
import V2ProfileSessionsPanel from './components/V2ProfileSessionsPanel.vue';
import { useProfilePage } from './useProfilePage';
import '@/v2/styles/records.css';
import '@/v2/styles/profile.css';

const page = reactive(useProfilePage());
</script>
