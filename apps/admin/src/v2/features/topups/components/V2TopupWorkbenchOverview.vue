<template>
  <V2PageOverview
    class="v2-topup-overview"
    aria-label="ID 加额工作台概览"
    title="ID 加额总览"
    help="未售出与已售出 ID 分开处理；已售 ID 加卡前必须核对原销售订单和客户归属。"
    metrics-label="当前页 ID 加额指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="筛选结果"
        :value="page.total"
        :note="page.activeList === 'sold' ? '已售出 ID' : '未售出 ID'"
      />
      <V2OverviewMetric label="当前页" :value="page.items.length" note="本页已加载" />
      <V2OverviewMetric label="状态正常" :value="normalCount" note="当前页正常 ID" />
      <V2OverviewMetric label="加卡记录" :value="topupRecordCount" note="当前页累计笔数" />
    </template>
    <template #actions>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadWorkbench">
        <el-icon><Refresh /></el-icon>
        刷新数据
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
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const normalCount = computed(
  () => props.page.items.filter((item) => item.status.code === 'normal').length
);
const topupRecordCount = computed(() =>
  props.page.items.reduce((total, item) => total + item.topupRecordCount, 0)
);
</script>
