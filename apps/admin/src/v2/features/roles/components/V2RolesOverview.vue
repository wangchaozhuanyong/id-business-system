<template>
  <section class="v2-roles-overview" aria-label="角色权限总览">
    <div class="v2-roles-overview__intro">
      <span>访问权限策略</span>
      <h2>角色权限总览</h2>
      <p>集中维护岗位权限、敏感资料审核策略和成员影响范围。</p>
    </div>

    <div class="v2-roles-overview__metrics" aria-label="当前角色权限指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配角色</small>
      </article>
      <article>
        <span>本页系统角色</span>
        <strong>{{ systemRoleCount }}</strong>
        <small>内置策略只读</small>
      </article>
      <article>
        <span>本页自定义角色</span>
        <strong>{{ customRoleCount }}</strong>
        <small>可维护业务权限</small>
      </article>
      <article>
        <span>本页关联成员</span>
        <strong>{{ memberCount }}</strong>
        <small>保存后即时生效</small>
      </article>
    </div>

    <div class="v2-roles-overview__actions">
      <el-tag effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadRoles">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新建角色
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
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
