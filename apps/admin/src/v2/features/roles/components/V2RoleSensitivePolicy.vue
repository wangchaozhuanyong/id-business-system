<template>
  <div class="v2-role-sensitive-policy" aria-labelledby="v2-role-sensitive-policy-title">
    <header class="v2-role-sensitive-policy__heading">
      <div>
        <h4 id="v2-role-sensitive-policy-title">敏感资料展示策略</h4>
        <p>按资料字段和使用位置设置员工看到的内容。</p>
      </div>
      <strong>{{ page.sensitiveDisplayPolicyCount }} 个场景</strong>
    </header>

    <el-alert
      v-if="page.isSystemRole"
      type="info"
      title="管理员业务资料完整显示；密码和密保需点击查看；审计日志始终脱敏"
      :closable="false"
      show-icon
    />

    <ul v-else-if="page.sensitiveDisplayFieldGroups.length">
      <li v-for="group in page.sensitiveDisplayFieldGroups" :key="group.fieldKey">
        <header>
          <strong>{{ group.fieldLabel }}</strong>
        </header>
        <div
          v-for="item in group.contexts"
          :key="item.context"
          class="v2-role-sensitive-policy__row"
        >
          <span>{{ item.contextLabel }}</span>
          <el-select
            :model-value="page.getSensitiveDisplayMode(item.fieldKey, item.context)"
            :aria-label="`${item.fieldLabel}在${item.contextLabel}的展示方式`"
            @change="page.setSensitiveDisplayMode(item.fieldKey, item.context, $event)"
          >
            <el-option
              v-for="mode in item.allowedModes"
              :key="mode"
              :label="page.sensitiveDisplayModeLabels[mode]"
              :value="mode"
            />
          </el-select>
        </div>
      </li>
    </ul>

    <p v-else class="v2-role-sensitive-policy__empty">当前未选择敏感资料权限。</p>
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

.v2-role-sensitive-policy__heading {
  display: flex;
  align-items: flex-start;
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

.v2-role-sensitive-policy__heading p,
.v2-role-sensitive-policy__empty {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.5;
}

.v2-role-sensitive-policy__heading > strong {
  flex: 0 0 auto;
  color: var(--v2-text-soft);
  font-size: 12px;
  font-weight: 500;
}

.v2-role-sensitive-policy ul {
  display: grid;
  gap: 10px;
  padding: 0;
  list-style: none;
}

.v2-role-sensitive-policy li {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-small);
  background: var(--el-bg-color);
}

.v2-role-sensitive-policy li > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.v2-role-sensitive-policy__row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(150px, 190px);
  align-items: center;
  gap: 12px;
  min-height: 34px;
  padding-top: 8px;
  border-top: 1px solid var(--v2-border);
  color: var(--v2-text-secondary);
  font-size: 13px;
}

@media (max-width: 620px) {
  .v2-role-sensitive-policy__heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-role-sensitive-policy__row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
