<template>
  <V2PageOverview
    class="v2-audit-overview"
    aria-label="审计日志总览"
    title="审计日志总览"
    help="追踪业务变更、敏感资料访问和受控数据恢复入口。"
    metrics-label="当前审计日志指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="当前日志类型" />
      <V2OverviewMetric label="本页记录" :value="page.currentItems.length" note="当前分页数据" />
      <V2OverviewMetric label="当前视图" :value="currentTabLabel" note="日志口径已分离" />
      <V2OverviewMetric
        label="本页未批准访问"
        :value="pendingApprovalCount"
        note="仅敏感访问视图"
      />
    </template>
    <template #actions>
      <el-tag effect="plain" type="info">权限受控</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton :loading="page.exporting" @click="page.exportCurrent">
        <el-icon><Download /></el-icon>
        导出
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed, type UnwrapNestedRefs } from 'vue';
import { Download, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

const props = defineProps<{ page: AuditLogsPage }>();

const currentTabLabel = computed(() =>
  props.page.activeTab === 'operations' ? '操作审计' : '敏感访问'
);
const pendingApprovalCount = computed(() =>
  props.page.activeTab === 'sensitive_access'
    ? props.page.sensitiveItems.filter((item) => !item.approved).length
    : 0
);
</script>
