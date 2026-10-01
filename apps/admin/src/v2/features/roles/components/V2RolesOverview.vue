<template>
  <V2PageOverview
    class="v2-roles-overview"
    aria-label="角色权限总览"
    title="角色权限总览"
    help="集中维护岗位权限、敏感资料审核策略和成员影响范围。"
    metrics-label="当前角色权限指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配角色" />
      <V2OverviewMetric label="本页系统角色" :value="systemRoleCount" note="内置策略只读" />
      <V2OverviewMetric label="本页自定义角色" :value="customRoleCount" note="可维护业务权限" />
      <V2OverviewMetric label="本页关联成员" :value="memberCount" note="保存后即时生效" />
    </template>
    <template #actions>
      <el-tag effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadRoles">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新建角色
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
import type { useRolesPage } from '../useRolesPage';

type RolesPage = UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;

const props = defineProps<{ page: RolesPage }>();

const systemRoleCount = computed(() => props.page.items.filter((item) => item.isSystemRole).length);
const customRoleCount = computed(() => props.page.items.length - systemRoleCount.value);
const memberCount = computed(() =>
  props.page.items.reduce((total, item) => total + item.memberCount, 0)
);
</script>
