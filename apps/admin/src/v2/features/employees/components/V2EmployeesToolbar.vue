<template>
  <V2ListToolbar
    class="v2-employees-command-panel"
    aria-label="员工账户筛选"
    title="账户筛选"
    help="按登录账号、姓名、状态或角色定位内部员工账户。"
  >
    <V2SearchInput
      v-model="page.query.keyword"
      draft-key="employees:V2EmployeesToolbar:page.query.keyword"
      clearable
      placeholder="登录账号、员工姓名"
      aria-label="搜索员工账户"
      @search="page.handleSearch"
    />
    <el-select
      v-model="page.query.status"
      clearable
      placeholder="全部状态"
      aria-label="筛选员工账号状态"
      @change="page.handleFilterChange"
    >
      <el-option label="启用" value="active" />
      <el-option label="停用" value="disabled" />
    </el-select>
    <el-select
      v-model="page.query.roleId"
      clearable
      filterable
      placeholder="全部角色"
      aria-label="筛选员工角色"
      @change="page.handleFilterChange"
    >
      <el-option
        v-for="role in page.roleOptions"
        :key="role.id"
        :label="role.name"
        :value="role.id"
      />
    </el-select>
    <template #actions>
      <AppButton :disabled="!page.activeFilterCount" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        重置
      </AppButton></template
    >
    <template #meta>
      <span>{{
        page.activeFilterCount ? `已启用 ${page.activeFilterCount} 项筛选` : '全部账户'
      }}</span>
    </template>
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2SearchInput from '@/v2/components/V2SearchInput.vue';
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useEmployeesPage } from '../useEmployeesPage';

type EmployeesPage = UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;

defineProps<{ page: EmployeesPage }>();
</script>
