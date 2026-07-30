<template>
  <V2FormDrawer
    v-model="page.drawerVisible"
    :title="page.editingItem ? '角色详情与权限' : '新建角色'"
    :confirm-text="page.editingItem ? '保存修改' : '确认创建'"
    :confirm-loading="page.saving"
    :confirm-disabled="page.isSystemRole"
    :confirm-disabled-reason="page.isSystemRole ? '系统管理员角色为只读角色' : ''"
    :dirty="page.drawerDirty"
    size="min(760px, 96vw)"
    @confirm="page.submitRole(formRef)"
  >
    <el-alert
      v-if="page.mutationError"
      class="v2-role-drawer__alert"
      type="error"
      :title="page.mutationError"
      show-icon
      :closable="false"
    />
    <el-alert
      v-if="page.isSystemRole"
      class="v2-role-drawer__alert"
      type="info"
      title="系统管理员角色拥有全部系统权限，不允许修改"
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
      :disabled="page.isSystemRole"
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <el-form-item label="角色名称" prop="name">
        <el-input v-model="page.form.name" maxlength="100" show-word-limit />
      </el-form-item>
      <el-form-item label="角色编码" prop="code">
        <el-input
          v-model="page.form.code"
          :disabled="Boolean(page.editingItem)"
          maxlength="100"
          placeholder="例如 operation"
          @input="page.normalizeCode"
        />
      </el-form-item>
      <el-form-item label="角色说明" prop="description">
        <el-input
          v-model="page.form.description"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
        />
      </el-form-item>
      <el-form-item label="权限矩阵" prop="permissionIds">
        <div class="v2-role-permissions">
          <header>
            <strong>已选择 {{ page.selectedPermissionCount }} 项</strong>
          </header>
          <div class="v2-role-permission-groups">
            <section
              v-for="group in page.permissionGroups"
              :key="group.module"
              class="v2-role-permission-group"
            >
              <header>
                <el-checkbox
                  :model-value="page.isGroupSelected(group)"
                  :indeterminate="page.isGroupIndeterminate(group)"
                  @change="page.toggleGroup(group, Boolean($event))"
                >
                  {{ group.label }}
                </el-checkbox>
                <span>{{ group.permissions.length }} 项</span>
              </header>
              <el-checkbox-group v-model="page.form.permissionIds">
                <div>
                  <el-checkbox
                    v-for="permission in group.permissions"
                    :key="permission.id"
                    :value="permission.id"
                  >
                    <span>{{ permission.name }}</span>
                    <small>{{ permission.code }}</small>
                  </el-checkbox>
                </div>
              </el-checkbox-group>
            </section>
          </div>
        </div>
      </el-form-item>
    </el-form>

    <section v-if="page.editingItem" class="v2-role-members">
      <header>
        <h3>角色成员</h3>
        <span>{{ page.editingItem.memberCount }} 人</span>
      </header>
      <V2AsyncRegion
        variant="section"
        skeleton="inline"
        :loading="page.detailLoading"
        :resolved="page.detailResolved"
        :error="page.detailError"
        :empty="page.detailResolved && !page.members.length"
        loading-title="正在加载角色成员"
        refreshing-title="正在更新角色成员"
        empty-title="暂无角色成员"
        empty-message="当前没有员工使用该角色。"
        error-title="角色成员加载失败"
        @retry="page.loadRoleDetail"
      >
        <ul class="v2-role-member-list">
          <li v-for="member in page.members" :key="member.id">
            <span>
              <strong>{{ member.displayName }}</strong>
              <small>{{ member.username }}</small>
            </span>
            <el-tag :type="member.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ member.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </li>
        </ul>
      </V2AsyncRegion>
    </section>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { useRolesPage } from '../useRolesPage';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;
}>();

const formRef = ref<FormInstance>();
</script>

<style scoped>
.v2-role-drawer__alert {
  margin-bottom: 18px;
}

.v2-role-permissions {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 8px;
}

.v2-role-permissions > header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-role-permission-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--v2-border);
}

.v2-role-permission-group {
  min-width: 0;
  padding: 12px 14px;
  border-bottom: 1px solid var(--v2-border);
}

.v2-role-permission-group:nth-child(odd) {
  border-right: 1px solid var(--v2-border);
}

.v2-role-permission-group > header {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.v2-role-permission-group > header > span {
  flex: 0 0 auto;
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-role-permission-group :deep(.el-checkbox-group > div) {
  display: grid;
  gap: 5px;
  padding-left: 24px;
}

.v2-role-permission-group :deep(.el-checkbox) {
  width: 100%;
  height: auto;
  min-height: 28px;
  margin-right: 0;
  white-space: normal;
}

.v2-role-permission-group :deep(.el-checkbox__label) {
  display: grid;
  min-width: 0;
  line-height: 1.35;
}

.v2-role-permission-group small {
  color: var(--v2-text-soft);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.v2-role-members {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--v2-border);
}

.v2-role-members > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.v2-role-members h3 {
  margin: 0;
  font-size: 14px;
}

.v2-role-members > header span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-role-member-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-role-member-list li {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-role-member-list li > span {
  display: grid;
  min-width: 0;
}

.v2-role-member-list small {
  color: var(--v2-text-soft);
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .v2-role-permission-groups {
    grid-template-columns: 1fr;
  }

  .v2-role-permission-group:nth-child(odd) {
    border-right: 0;
  }
}
</style>
