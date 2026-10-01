<template>
  <V2PageOverview
    class="v2-renewals-overview"
    aria-label="续费工作台概览"
    title="续费管理总览"
    help="集中处理临期与到期业务，续费动作继续受权限、时间窗口和余额校验控制。"
    metrics-label="当前页续费指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配记录" />
      <V2OverviewMetric label="当前页" :value="page.items.length" note="本页已加载" />
      <V2OverviewMetric label="续费预警" :value="warningCount" note="当前页临期记录" />
      <V2OverviewMetric label="可执行续费" :value="actionableCount" note="当前页时间窗内" />
    </template>
    <template #actions>
      <AppButton
        v-if="page.canManageWarning"
        variant="ghost"
        title="设置续费提前预警天数"
        @click="page.openWarningSettings"
      >
        <el-icon><Setting /></el-icon>
        预警设置
      </AppButton>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadWorkbench">
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
import { Refresh, Setting } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useRenewalsPage } from '../useRenewalsPage';

type RenewalsPage = UnwrapNestedRefs<ReturnType<typeof useRenewalsPage>>;

const props = defineProps<{
  page: RenewalsPage;
}>();

const warningCount = computed(
  () => props.page.items.filter((item) => item.warningState === 'upcoming').length
);
const actionableCount = computed(
  () => props.page.items.filter((item) => item.withinActionWindow).length
);
</script>
