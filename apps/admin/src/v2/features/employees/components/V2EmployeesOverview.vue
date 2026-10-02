<template>
  <V2PageOverview
    class="v2-employees-overview"
    aria-label="员工账户总览"
    title="员工账户总览"
    help="账号、角色、在线会话和首次改密状态集中管理。"
    metrics-label="当前员工账户指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配账户" />
      <V2OverviewMetric label="本页启用" :value="activeCount" note="当前页可登录" />
      <V2OverviewMetric label="本页在线会话" :value="activeSessionCount" note="已登记有效会话" />
      <V2OverviewMetric label="本页待改密" :value="pendingPasswordCount" note="首次登录需处理" />
    </template>
    <template #actions>
      <el-tag class="v2-overview-access-tag" effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadEmployees">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="page.canManageEmployees" variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        开通员工
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed, type UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useEmployeesPage } from '../useEmployeesPage';

type EmployeesPage = UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;

const props = defineProps<{ page: EmployeesPage }>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.status === 'active').length
);
const activeSessionCount = computed(() =>
  props.page.items.reduce((total, item) => total + item.activeSessionCount, 0)
);
const pendingPasswordCount = computed(
  () => props.page.items.filter((item) => item.mustResetPassword).length
);
</script>
