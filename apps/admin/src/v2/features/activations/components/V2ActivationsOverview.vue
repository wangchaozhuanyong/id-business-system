<template>
  <div class="v2-page-stack v2-activations-overview-stack">
    <V2PageOverview
      class="v2-activations-overview"
      aria-label="开通记录概览"
      title="开通记录总览"
      help="集中核对开通、到期和异常状态；到期状态由系统按当前时间动态计算。"
      metrics-label="当前页开通指标"
    >
      <template #metrics>
        <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配记录" />
        <V2OverviewMetric label="当前页" :value="page.items.length" note="本页已加载" />
        <V2OverviewMetric label="正常开通" :value="activeCount" note="当前页正常记录" />
        <V2OverviewMetric label="到期风险" :value="riskCount" note="当前页临期或异常" />
      </template>
      <template #actions>
        <AppButton variant="ghost" :disabled="page.loading" @click="page.loadActivations">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
      </template>
    </V2PageOverview>

    <V2StatusStrip
      :items="page.activationStatusStripItems"
      :active-key="page.query.dueStatus"
      aria-label="当前页开通到期分布"
      @select="page.selectDueStatus"
    />
  </div>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import type { useActivationsPage } from '../useActivationsPage';

type ActivationsPage = UnwrapNestedRefs<ReturnType<typeof useActivationsPage>>;

const props = defineProps<{
  page: ActivationsPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.status.code === 'active').length
);
const riskCount = computed(
  () =>
    props.page.items.filter((item) =>
      [
        'due_within_1_hour',
        'due_within_23_hours',
        'due_within_7_days',
        'expired',
        'abnormal'
      ].includes(item.status.code)
    ).length
);
</script>
