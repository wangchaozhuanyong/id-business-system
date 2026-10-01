<template>
  <V2PageOverview
    class="v2-customers-overview"
    aria-label="客户资料概览"
    title="客户资料总览"
    help="集中维护客户来源、标签和历史业务，敏感联系方式默认脱敏。"
    metrics-label="当前页客户指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配客户" />
      <V2OverviewMetric label="当前页" :value="page.items.length" note="本页已加载" />
      <V2OverviewMetric label="启用资料" :value="activeCount" note="当前页正常客户" />
      <V2OverviewMetric label="敏感联系方式" :value="sensitiveContactCount" note="当前页受控查看" />
    </template>
    <template #actions>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadCustomers">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新增客户
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
import type { useCustomersPage } from '../useCustomersPage';

type CustomersPage = UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;

const props = defineProps<{
  page: CustomersPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.recordStatus === 'active').length
);
const sensitiveContactCount = computed(
  () => props.page.items.filter((item) => item.hasPhone || item.hasWhatsapp).length
);
</script>
