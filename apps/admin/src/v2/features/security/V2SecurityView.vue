<template>
  <section class="v2-records-page v2-security-page">
    <V2SecurityOverview :page="page" />
    <V2SecurityNavigation :page="page" />
    <V2SecurityToolbar :page="page" />

    <p class="v2-security-note">
      <el-icon><Lock /></el-icon>
      强制下线、策略状态和白名单读取均受管理员角色保护；所有高风险写操作都会写入审计。
    </p>

    <V2AsyncRegion
      skeleton="table"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.listError"
      loading-title="正在加载安全中心"
      refreshing-title="正在更新安全状态"
      error-title="安全中心加载失败"
      @retry="page.refresh"
    >
      <V2SecurityPolicyPanel v-if="page.activeTab === 'policy'" :page="page" />
      <V2SecurityRecordsPanel v-else :page="page" />
    </V2AsyncRegion>

    <V2SecurityPolicyDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Lock } from '@element-plus/icons-vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SecurityNavigation from './components/V2SecurityNavigation.vue';
import V2SecurityOverview from './components/V2SecurityOverview.vue';
import V2SecurityPolicyDialogs from './components/V2SecurityPolicyDialogs.vue';
import V2SecurityPolicyPanel from './components/V2SecurityPolicyPanel.vue';
import V2SecurityRecordsPanel from './components/V2SecurityRecordsPanel.vue';
import V2SecurityToolbar from './components/V2SecurityToolbar.vue';
import { useSecurityPage } from './useSecurityPage';
import '@/v2/styles/records.css';
import '@/v2/styles/security.css';

const page = reactive(useSecurityPage());
</script>
