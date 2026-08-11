<template>
  <section class="v2-audit-navigation" aria-label="审计日志类型">
    <V2SectionHeading title="日志类型">
      <template #actions>
        <span>操作变更与敏感访问分别记录，互不混用。</span>
      </template>
    </V2SectionHeading>
    <el-tabs v-model="page.activeTab" @tab-change="page.handleTabChange">
      <el-tab-pane label="操作审计" name="operations" />
      <el-tab-pane label="敏感访问" name="sensitive_access" />
    </el-tabs>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

defineProps<{ page: AuditLogsPage }>();
</script>
