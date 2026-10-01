<template>
  <V2PageOverview
    class="v2-options-overview"
    aria-label="设置管理概览"
    title="业务选项总览"
    help="集中维护各业务模块共用的分类、国家、供应商和结算基础资料。"
    metrics-label="当前选项指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="配置分类"
        :value="page.typeDefinitions.length"
        note="当前可维护类型"
      />
      <V2OverviewMetric
        label="当前分类"
        :value="page.selectedTypeDefinition?.label ?? '选项'"
        note="左侧目录可切换"
      />
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配记录" />
      <V2OverviewMetric label="当前页启用" :value="activeCount" note="本页可选记录" />
    </template>
    <template #actions>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.handleRefresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton variant="primary" :disabled="page.loading" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新增{{ page.selectedTypeDefinition?.label ?? '选项' }}
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useOptionsPage } from '../useOptionsPage';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

const props = defineProps<{
  page: OptionsPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.status === 'active').length
);
</script>
