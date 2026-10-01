<template>
  <V2PageOverview
    class="v2-business-monitoring-overview"
    aria-label="业务监控总览"
    title="业务风险总览"
    help="异常直接来自订单、余额、续费、汇率采集和财务基线；修正源数据后自动退出队列。"
    metrics-label="当前业务风险指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="当前异常"
        :value="page.summary?.total ?? '—'"
        note="当前源数据快照"
      />
      <V2OverviewMetric
        label="紧急风险"
        :value="page.summary?.critical ?? '—'"
        note="需要优先复核"
      />
      <V2OverviewMetric
        label="警告风险"
        :value="page.summary?.warning ?? '—'"
        note="需要业务跟进"
      />
      <V2OverviewMetric
        label="实时规则"
        :value="page.summary ? page.rules.length : '—'"
        note="不维护第二套状态"
      />
    </template>
    <template #actions>
      <span>{{
        page.generatedAt
          ? `更新于 ${page.formatBusinessMonitoringDate(page.generatedAt)}`
          : '等待首个快照'
      }}</span>
      <el-tag type="success" effect="plain">源状态计算</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

defineProps<{ page: BusinessMonitoringPage }>();
</script>
