<template>
  <div class="v2-role-sensitive-policy" aria-labelledby="v2-role-sensitive-policy-title">
    <header>
      <div>
        <h4 id="v2-role-sensitive-policy-title">敏感资料审批</h4>
        <p>开关开启后，该角色查看对应完整资料必须先由管理员批准。</p>
      </div>
      <strong>{{ page.sensitiveApprovalCount }} 项需要审批</strong>
    </header>
    <el-alert
      v-if="page.isSystemRole"
      type="info"
      title="管理员直接查看敏感资料，不受审批开关限制"
      :closable="false"
      show-icon
    />
    <ul v-else-if="page.selectedSensitivePermissions.length">
      <li v-for="permission in page.selectedSensitivePermissions" :key="permission.id">
        <span>
          <strong>{{ permission.name }}</strong>
          <small>{{ permission.code }}</small>
        </span>
        <el-switch
          :model-value="page.isSensitiveApprovalRequired(permission.id)"
          active-text="需要审批"
          inactive-text="直接查看"
          :aria-label="`${permission.name}审批策略`"
          @change="page.toggleSensitiveApproval(permission.id, Boolean($event))"
        />
      </li>
    </ul>
    <p v-else class="v2-role-sensitive-policy__empty">当前未选择可配置审批的敏感资料权限。</p>
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { useRolesPage } from '../useRolesPage';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;
}>();
</script>

<style scoped>
.v2-role-sensitive-policy {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-extra-light);
}

.v2-role-sensitive-policy > header,
.v2-role-sensitive-policy li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.v2-role-sensitive-policy h4,
.v2-role-sensitive-policy p,
.v2-role-sensitive-policy ul {
  margin: 0;
}

.v2-role-sensitive-policy h4 {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-role-sensitive-policy header p,
.v2-role-sensitive-policy__empty,
.v2-role-sensitive-policy small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.5;
}

.v2-role-sensitive-policy header > strong {
  flex: 0 0 auto;
  color: var(--v2-text-soft);
  font-size: 12px;
  font-weight: 500;
}

.v2-role-sensitive-policy ul {
  display: grid;
  gap: 8px;
  padding: 0;
  list-style: none;
}

.v2-role-sensitive-policy li {
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-small);
  background: var(--el-bg-color);
}

.v2-role-sensitive-policy li > span {
  display: grid;
  min-width: 0;
}

@media (max-width: 620px) {
  .v2-role-sensitive-policy > header,
  .v2-role-sensitive-policy li {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
