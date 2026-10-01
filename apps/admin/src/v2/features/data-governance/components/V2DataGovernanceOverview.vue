<template>
  <V2PageOverview
    class="v2-governance-overview-hero"
    aria-label="数据治理总览"
    title="数据治理总览"
    help="恢复和清理先冻结影响预览、核验备份证据，再由另一名管理员审批并分批执行。"
    metrics-label="当前治理指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="回收站记录"
        :value="page.overview?.recycleBin.total ?? '—'"
        note="仅统计软删除记录"
      />
      <V2OverviewMetric
        label="当前页待审批"
        :value="pendingApprovalCount"
        note="必须由非申请人审批"
      />
      <V2OverviewMetric
        label="可用审批人"
        :value="page.overview?.approvalReadiness.eligibleApproverCount ?? '—'"
        note="其他启用管理员"
      />
      <V2OverviewMetric
        label="可用能力"
        :value="availableCapabilityCount"
        note="当前治理能力状态"
      />
    </template>
    <template #actions>
      <span>中国标准时间</span>
      <el-tag :type="page.overview?.approvalReadiness.ready ? 'success' : 'warning'" effect="plain">
        {{ page.overview?.approvalReadiness.ready ? '审批条件就绪' : '审批条件待核验' }}
      </el-tag>
      <AppButton variant="ghost" :disabled="page.overviewLoading" @click="page.refreshOverview">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ page: DataGovernancePage }>();
const pendingApprovalCount = computed(
  () => props.page.jobs.filter((job) => job.status === 'pending_approval').length
);
const availableCapabilityCount = computed(() => {
  if (!props.page.overview) return '—';
  return props.page.overview.capabilities.filter((item) => item.status === 'available').length;
});
</script>
