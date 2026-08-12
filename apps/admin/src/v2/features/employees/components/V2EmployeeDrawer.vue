<template>
  <V2FormDrawer
    v-model="page.drawerVisible"
    :title="page.editingItem ? '编辑员工账号' : '开通员工账号'"
    :confirm-text="page.editingItem ? '保存修改' : '确认开通'"
    :confirm-loading="page.saving"
    :dirty="page.drawerDirty"
    @confirm="page.submitEmployee(formRef)"
  >
    <el-alert
      v-if="page.mutationError"
      class="v2-employee-drawer__alert"
      type="error"
      :title="page.mutationError"
      show-icon
      :closable="false"
    />
    <el-alert
      v-if="!page.editingItem"
      class="v2-employee-drawer__alert"
      type="info"
      title="新员工首次登录后必须修改初始密码"
      show-icon
      :closable="false"
    />
    <el-form
      ref="formRef"
      class="v2-horizontal-form"
      :model="page.form"
      :rules="page.formRules"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <el-form-item label="登录账号" prop="username">
        <el-input
          v-model="page.form.username"
          :disabled="Boolean(page.editingItem)"
          maxlength="100"
          autocomplete="off"
          placeholder="例如 operator01"
          @input="normalizeUsername"
        />
      </el-form-item>
      <el-form-item label="员工姓名" prop="displayName">
        <el-input v-model="page.form.displayName" maxlength="100" show-word-limit />
      </el-form-item>
      <el-form-item v-if="!page.editingItem" label="初始密码" prop="initialPassword">
        <el-input
          v-model="page.form.initialPassword"
          type="password"
          show-password
          maxlength="160"
          autocomplete="new-password"
        />
      </el-form-item>
      <el-form-item label="角色" prop="roleIds">
        <el-select
          v-model="page.form.roleIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          filterable
          :disabled="page.isEditingSelf"
          placeholder="选择员工角色"
        >
          <el-option
            v-for="role in page.roleOptions"
            :key="role.id"
            :label="`${role.name}（${role.code}）`"
            :value="role.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="page.editingItem" label="账号状态">
        <el-switch
          v-model="page.form.status"
          active-value="active"
          inactive-value="disabled"
          active-text="启用"
          inactive-text="停用"
          :disabled="page.isEditingSelf"
        />
      </el-form-item>
      <el-alert
        v-if="page.isEditingSelf"
        class="v2-employee-drawer__inline-alert"
        type="warning"
        title="当前登录账号不能修改自己的角色或状态"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else-if="page.securitySensitiveChangeMessage"
        class="v2-employee-drawer__inline-alert"
        type="warning"
        :title="page.securitySensitiveChangeMessage"
        show-icon
        :closable="false"
      />
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { useEmployeesPage } from '../useEmployeesPage';

const props = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;
}>();

const formRef = ref<FormInstance>();

function normalizeUsername(value: string) {
  if (props.page.editingItem) return;
  props.page.form.username = value.toLowerCase().replace(/\s+/g, '');
}
</script>

<style scoped>
.v2-employee-drawer__alert {
  margin-bottom: 18px;
}

.v2-employee-drawer__inline-alert {
  margin-top: 8px;
}
</style>
