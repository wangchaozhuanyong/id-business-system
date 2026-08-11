<template>
  <section class="v2-security-navigation" aria-label="安全中心视图">
    <V2SectionHeading title="安全视图">
      <template #actions>
        <span>登录记录、在线会话与访问策略分别管理。</span>
      </template>
    </V2SectionHeading>
    <el-tabs v-model="page.activeTab" @tab-change="page.handleTabChange">
      <el-tab-pane label="登录记录" name="login_logs" />
      <el-tab-pane label="在线会话" name="sessions" />
      <el-tab-pane label="MFA 与白名单" name="policy" />
    </el-tabs>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

defineProps<{ page: SecurityPage }>();
</script>
