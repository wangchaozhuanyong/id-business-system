<template>
  <V2PageOverview
    class="v2-audit-overview"
    aria-label="审计日志总览"
    title="审计日志总览"
    help="仅管理员和超级管理员可查看。记录账号对哪条资料做了什么，以及已保存的修改前后内容。支持的误删资料可申请恢复；密码和账务不能从日志直接还原。操作人显示账号当前姓名，账号交给新员工后，历史仍按同一账号追溯。"
    metrics-label="当前审计日志指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="当前日志类型" />
      <V2OverviewMetric label="本页记录" :value="page.currentItems.length" note="当前分页数据" />
      <V2OverviewMetric label="正在查看" :value="currentTabLabel" note="可切换记录类型" />
      <V2OverviewMetric
        :label="page.activeTab === 'operations' ? '本页可申请恢复' : '本页未获准查看'"
        :value="page.activeTab === 'operations' ? restoreCount : pendingApprovalCount"
        :note="page.activeTab === 'operations' ? '需核对回收站并审批' : '仅统计当前页'"
      />
    </template>
    <template #actions>
      <el-tag effect="plain" type="info">仅管理员可见</el-tag>
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
  props.page.activeTab === 'operations' ? '操作记录' : '敏感资料查看记录'
);
const restoreCount = computed(
  () =>
    props.page.operationItems.filter((item) => props.page.getOperationAuditRestoreCandidate(item))
      .length
);
const pendingApprovalCount = computed(() =>
  props.page.activeTab === 'sensitive_access'
    ? props.page.sensitiveItems.filter((item) => !item.approved).length
    : 0
);
</script>
