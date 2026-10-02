<template>
  <span v-if="!page.canManageEmployees" title="仅超级管理员可管理员工账号">仅可查看</span>
  <el-dropdown v-else trigger="click" @command="handleCommand">
    <AppButton size="small" variant="ghost" :aria-label="`${employee.username} 的更多操作`"
      >更多操作<el-icon><ArrowDown /></el-icon
    ></AppButton>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="edit">编辑资料</el-dropdown-item>
        <el-dropdown-item command="reset" :disabled="employee.isSystemSuperAdmin"
          >重置密码</el-dropdown-item
        >
        <el-dropdown-item command="delete" :disabled="employee.isSystemSuperAdmin"
          >删除账号并移交业务</el-dropdown-item
        >
        <el-dropdown-item v-if="employee.isSystemSuperAdmin" disabled
          >超级管理员受保护</el-dropdown-item
        >
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { ArrowDown } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2Employee } from '../contracts';
import type { useEmployeesPage } from '../useEmployeesPage';

const props = defineProps<{
  employee: V2Employee;
  page: UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;
}>();
function handleCommand(command: string) {
  if (command === 'edit') props.page.openEdit(props.employee);
  if (command === 'reset') props.page.accountActions.openReset(props.employee);
  if (command === 'delete') props.page.accountActions.openDelete(props.employee);
}
</script>
