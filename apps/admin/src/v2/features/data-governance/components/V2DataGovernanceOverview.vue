<template>
  <section class="v2-governance-overview-hero" aria-label="数据治理总览">
    <div class="v2-governance-overview-hero__intro">
      <span class="v2-governance-overview-hero__eyebrow">数据治理</span>
      <h2>数据治理总览</h2>
      <p>恢复和清理先冻结影响预览、核验备份证据，再由另一名管理员审批并分批执行。</p>
    </div>

    <div class="v2-governance-overview-hero__metrics" aria-label="当前治理指标">
      <article>
        <span>回收站记录</span>
        <strong>{{ page.overview?.recycleBin.total ?? '—' }}</strong>
        <small>仅统计软删除记录</small>
      </article>
      <article>
        <span>当前页待审批</span>
        <strong>{{ pendingApprovalCount }}</strong>
        <small>必须由非申请人审批</small>
      </article>
      <article>
        <span>可用审批人</span>
        <strong>{{ page.overview?.approvalReadiness.eligibleApproverCount ?? '—' }}</strong>
        <small>其他启用管理员</small>
      </article>
      <article>
        <span>可用能力</span>
        <strong>{{ availableCapabilityCount }}</strong>
        <small>当前治理能力状态</small>
      </article>
    </div>

    <div class="v2-governance-overview-hero__actions">
      <span>吉隆坡时区</span>
      <el-tag :type="page.overview?.approvalReadiness.ready ? 'success' : 'warning'" effect="plain">
        {{ page.overview?.approvalReadiness.ready ? '审批条件就绪' : '审批条件待核验' }}
      </el-tag>
      <AppButton variant="ghost" :disabled="page.overviewLoading" @click="page.refreshOverview">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
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
