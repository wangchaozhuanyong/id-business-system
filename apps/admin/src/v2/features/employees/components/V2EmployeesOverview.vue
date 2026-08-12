<template>
  <section class="v2-employees-overview" aria-label="员工账户总览">
    <div class="v2-employees-overview__intro">
      <span>员工访问管理</span>
      <h2>员工账户总览</h2>
      <p>账号、角色、在线会话和首次改密状态集中管理。</p>
    </div>

    <div class="v2-employees-overview__metrics" aria-label="当前员工账户指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配账户</small>
      </article>
      <article>
        <span>本页启用</span>
        <strong>{{ activeCount }}</strong>
        <small>当前页可登录</small>
      </article>
      <article>
        <span>本页在线会话</span>
        <strong>{{ activeSessionCount }}</strong>
        <small>已登记有效会话</small>
      </article>
      <article>
        <span>本页待改密</span>
        <strong>{{ pendingPasswordCount }}</strong>
        <small>首次登录需处理</small>
      </article>
    </div>

    <div class="v2-employees-overview__actions">
      <el-tag effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadEmployees">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        开通员工
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
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
