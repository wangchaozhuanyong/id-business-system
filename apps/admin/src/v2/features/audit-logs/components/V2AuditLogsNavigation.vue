<template>
  <section class="v2-audit-navigation" aria-label="审计日志类型">
    <V2SectionHeading title="日志类型">
      <template #actions>
        <span>查看谁操作了资料、改了什么；支持的删除资料可申请恢复。</span>
      </template>
    </V2SectionHeading>
    <el-tabs v-model="page.activeTab" @tab-change="page.handleTabChange">
      <el-tab-pane label="操作记录" name="operations" />
      <el-tab-pane label="敏感资料查看记录" name="sensitive_access" />
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
