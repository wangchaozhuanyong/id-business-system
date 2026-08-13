<template>
  <V2FormDrawer
    v-model="page.drawerVisible"
    :title="page.editingItem ? '角色详情与权限' : '新建角色'"
    eyebrow="访问控制"
    description="按岗位职责配置角色信息、权限范围和敏感字段访问策略"
    :confirm-text="page.editingItem ? '保存修改' : '确认创建'"
    :confirm-loading="page.saving"
    :confirm-disabled="page.isSystemRole"
    :confirm-disabled-reason="page.isSystemRole ? '系统管理员角色为只读角色' : ''"
    :dirty="page.drawerDirty"
    size="min(880px, 96vw)"
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
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <section class="v2-role-section" aria-labelledby="v2-role-basics-title">
        <header class="v2-role-section__heading">
          <div>
            <h3 id="v2-role-basics-title">基本信息</h3>
            <p>用清晰的名称和说明帮助管理员识别角色用途。</p>
          </div>
        </header>
        <el-form-item label="角色名称" prop="name">
          <el-input
            v-model="page.form.name"
            :disabled="page.isSystemRole"
            maxlength="100"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="角色编码" prop="code">
          <el-input
            v-model="page.form.code"
            :disabled="Boolean(page.editingItem) || page.isSystemRole"
            maxlength="100"
            placeholder="例如 operation"
            @input="page.normalizeCode"
          />
        </el-form-item>
        <el-form-item label="角色说明" prop="description">
          <el-input
            v-model="page.form.description"
            :disabled="page.isSystemRole"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
          />
        </el-form-item>
      </section>

      <section class="v2-role-section" aria-labelledby="v2-role-permissions-title">
        <header class="v2-role-section__heading">
          <div>
            <h3 id="v2-role-permissions-title">权限配置 <span aria-hidden="true">*</span></h3>
            <p>按工作需要分配最小权限，避免授予无关的管理能力。</p>
          </div>
          <strong class="v2-role-section__count" role="status">
            已选 {{ page.selectedPermissionCount }} 项
          </strong>
        </header>

        <el-alert
          v-if="page.editingItem?.memberCount"
          class="v2-role-permissions__impact"
          type="warning"
          :title="`修改将立即影响 ${page.editingItem.memberCount} 名员工的访问权限`"
          show-icon
          :closable="false"
        />

        <el-form-item class="v2-role-permissions-item" prop="permissionIds" :show-message="false">
          <div class="v2-role-permissions">
            <div class="v2-role-permissions__toolbar">
              <el-input
                v-model="page.permissionKeyword"
                clearable
                aria-label="搜索权限"
                placeholder="搜索权限名称、编码或分组"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
              <div class="v2-role-permissions__actions">
                <el-checkbox v-model="page.selectedPermissionsOnly">仅看已选</el-checkbox>
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="page.isSystemRole || !page.selectedPermissionCount"
                  @click="clearPermissions"
                >
                  清空选择
                </AppButton>
              </div>
            </div>

            <p
              v-if="page.permissionSelectionError"
              id="v2-role-permission-error"
              class="v2-role-permissions__error"
              role="alert"
            >
              {{ page.permissionSelectionError }}
            </p>

            <el-collapse
              v-if="page.filteredPermissionGroups.length"
              v-model="page.activePermissionModules"
            >
              <el-collapse-item
                v-for="group in page.filteredPermissionGroups"
                :key="group.module"
                :name="group.module"
              >
                <template #title>
                  <div class="v2-role-permission-group__title">
                    <el-checkbox
                      :model-value="page.isGroupSelected(group)"
                      :indeterminate="page.isGroupIndeterminate(group)"
                      :disabled="page.isSystemRole"
                      :aria-label="`选择${group.label}分组的全部权限`"
                      @click.stop
                      @change="toggleGroup(group, Boolean($event))"
                    >
                      {{ group.label }}
                    </el-checkbox>
                    <span>{{ group.selectedCount }} / {{ group.allPermissions.length }} 项</span>
                  </div>
                </template>
                <el-checkbox-group
                  v-model="page.form.permissionIds"
                  :disabled="page.isSystemRole"
                  @change="validatePermissionSelection"
                >
                  <div class="v2-role-permission-group__options">
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
              </el-collapse-item>
            </el-collapse>

            <div v-else class="v2-role-permissions__empty">
              <strong>没有匹配的权限</strong>
              <span>请调整搜索内容或取消“仅看已选”。</span>
              <AppButton size="small" variant="ghost" @click="page.clearPermissionFilters">
                清除筛选
              </AppButton>
            </div>
          </div>
        </el-form-item>

        <V2RoleSensitivePolicy :page="page" />
      </section>
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
import { Search } from '@element-plus/icons-vue';
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { useRolesPage } from '../useRolesPage';
import V2RoleSensitivePolicy from './V2RoleSensitivePolicy.vue';

const props = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;
}>();

const formRef = ref<FormInstance>();

function validatePermissionSelection() {
  void formRef.value?.validateField('permissionIds').catch(() => undefined);
}

function toggleGroup(group: Parameters<typeof props.page.toggleGroup>[0], checked: boolean) {
  props.page.toggleGroup(group, checked);
  validatePermissionSelection();
}

function clearPermissions() {
  props.page.clearPermissionSelection();
  validatePermissionSelection();
}
</script>

<style scoped>
.v2-role-drawer__alert {
  margin-bottom: 18px;
}

.v2-role-section + .v2-role-section {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--v2-border);
}

.v2-role-section__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.v2-role-section__heading h3,
.v2-role-section__heading p {
  margin: 0;
}

.v2-role-section__heading h3 {
  color: var(--v2-text);
  font-size: 15px;
  line-height: 1.5;
}

.v2-role-section__heading h3 span {
  margin-left: 2px;
  color: var(--el-color-danger);
}

.v2-role-section__heading p {
  margin-top: 3px;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-role-section__count {
  flex: 0 0 auto;
  padding-top: 2px;
  color: var(--v2-text-soft);
  font-size: 12px;
  font-weight: 500;
}

.v2-role-permissions__impact {
  margin-bottom: 12px;
}

.v2-role-permissions-item {
  margin-bottom: 0;
}

.v2-role-permissions-item :deep(.el-form-item__content) {
  margin-left: 0 !important;
}

.v2-role-permissions {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 10px;
}

.v2-role-permissions__toolbar {
  position: sticky;
  z-index: 2;
  top: 0;
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  background: var(--el-bg-color);
}

.v2-role-permissions__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.v2-role-permissions__error {
  margin: -2px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
}

.v2-role-permissions :deep(.el-collapse) {
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
}

.v2-role-permissions :deep(.el-collapse-item__header) {
  min-height: 48px;
  height: auto;
  padding: 8px 14px;
  background: var(--el-fill-color-lighter);
  line-height: 1.4;
}

.v2-role-permissions :deep(.el-collapse-item__wrap) {
  border-bottom-color: var(--v2-border);
}

.v2-role-permissions :deep(.el-collapse-item__content) {
  padding: 4px 14px 12px;
}

.v2-role-permission-group__title {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 10px;
}

.v2-role-permission-group__title > span {
  flex: 0 0 auto;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-role-permission-group__options {
  display: grid;
  gap: 2px;
}

.v2-role-permission-group__options :deep(.el-checkbox) {
  width: 100%;
  height: auto;
  min-height: 40px;
  margin-right: 0;
  padding: 5px 8px;
  border-radius: var(--el-border-radius-small);
  white-space: normal;
}

.v2-role-permission-group__options :deep(.el-checkbox:hover) {
  background: var(--el-fill-color-light);
}

.v2-role-permission-group__options :deep(.el-checkbox__label) {
  display: grid;
  min-width: 0;
  line-height: 1.35;
}

.v2-role-permission-group__options small {
  color: var(--v2-text-soft);
  font-family: var(--el-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.v2-role-permissions__empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 34px 20px;
  border: 1px dashed var(--v2-border);
  border-radius: var(--el-border-radius-base);
  color: var(--v2-text-soft);
  text-align: center;
}

.v2-role-permissions__empty strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-role-permissions__empty span {
  font-size: 12px;
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

@media (max-width: 640px) {
  .v2-role-section__heading {
    gap: 10px;
  }

  .v2-role-permissions__toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-role-permissions__actions {
    justify-content: space-between;
  }

  .v2-role-permissions :deep(.el-collapse-item__header) {
    padding-inline: 10px;
  }
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
