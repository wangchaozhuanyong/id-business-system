<template>
  <section ref="listRef" class="v2-records-list v2-security-mfa-users" :style="listFrameStyle">
    <header class="v2-security-mfa-users__title">
      <V2SectionHeading title="用户 MFA 状态">
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.security.mfaUsers" />
          <span>本页 {{ page.mfaUserItems.length }} 人</span>
          <span aria-hidden="true">·</span>
          <strong>共 {{ page.mfaUserTotal }} 人</strong>
        </template>
      </V2SectionHeading>
      <div class="v2-security-mfa-users__tools">
        <span>仅显示绑定状态和恢复码数量，不返回密钥或恢复码哈希。</span>
        <div class="v2-security-mfa-users__search">
          <el-input
            v-model="page.query.mfaUserKeyword"
            clearable
            placeholder="账号或姓名"
            aria-label="搜索用户 MFA 状态"
            @keyup.enter="page.handleMfaUserSearch"
            @clear="page.handleMfaUserSearch"
          />
          <AppButton size="small" variant="ghost" @click="page.handleMfaUserSearch">搜索</AppButton>
        </div>
      </div>
    </header>
    <V2Table
      :schema="v2TableSchemas.security.mfaUsers"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.mfaUserItems"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <div class="v2-records-empty">
          <strong>暂无匹配用户</strong>
          <span>调整搜索条件后重试</span>
        </div>
      </template>
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[0]" prop="username" />
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[1]" prop="displayName" />
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[2]">
        <template #default="{ row }">{{ row.roles.join('、') || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[3]">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[4]">
        <template #default="{ row }">
          <el-tag
            :type="row.enabled ? 'success' : row.configured ? 'warning' : 'info'"
            effect="plain"
          >
            {{ row.enabled ? '已绑定' : row.configured ? '待验证' : '未绑定' }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.mfaUsers.columns[5]"
        prop="recoveryCodeCount"
      />
      <V2TableColumn :definition="v2TableSchemas.security.mfaUsers.columns[6]" prop="lastUsedAt">
        <template #default="{ row }">{{ page.formatSecurityDate(row.lastUsedAt) }}</template>
      </V2TableColumn>
      <V2TableActionColumn :definition="v2TableSchemas.security.mfaUsers.columns[7]">
        <template #default="{ row }">
          <AppButton
            size="small"
            variant="danger"
            :disabled="!row.configured"
            :loading="page.resettingMfaUserId === row.id"
            :title="row.configured ? '重置该用户 MFA' : '该用户尚未配置 MFA'"
            @click="page.resetUserMfa(row)"
          >
            重置 MFA
          </AppButton>
        </template>
      </V2TableActionColumn>
    </V2Table>
    <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.security.mfaUsers.id">
      <article v-for="item in page.mfaUserItems" :key="item.id" class="v2-records-mobile-item">
        <header>
          <div>
            <strong v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, 'displayName']">
              {{ item.displayName }}
            </strong>
            <span v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, 'username']">
              {{ item.username }}
            </span>
            <span v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, '角色']">
              {{ item.roles.join('、') || '无角色' }}
            </span>
          </div>
          <el-tag
            v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, 'MFA']"
            :type="item.enabled ? 'success' : item.configured ? 'warning' : 'info'"
            effect="plain"
          >
            {{ item.enabled ? '已绑定' : item.configured ? '待验证' : '未绑定' }}
          </el-tag>
        </header>
        <dl>
          <div v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, '账号状态']">
            <dt>账号状态</dt>
            <dd>{{ item.status === 'active' ? '启用' : '停用' }}</dd>
          </div>
          <div v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, 'recoveryCodeCount']">
            <dt>恢复码</dt>
            <dd>{{ item.recoveryCodeCount }} 个</dd>
          </div>
          <div
            v-v2-column-visibility="[v2TableSchemas.security.mfaUsers.id, 'lastUsedAt']"
            class="v2-security-mfa-users__mobile-wide"
          >
            <dt>最近使用</dt>
            <dd>{{ page.formatSecurityDate(item.lastUsedAt) }}</dd>
          </div>
        </dl>
        <footer class="v2-records-mobile-item__actions">
          <AppButton
            size="small"
            variant="danger"
            :disabled="!item.configured"
            :loading="page.resettingMfaUserId === item.id"
            @click="page.resetUserMfa(item)"
          >
            重置 MFA
          </AppButton>
        </footer>
      </article>
    </div>
    <footer class="v2-records-pagination">
      <span>共 {{ page.mfaUserTotal }} 人</span>
      <el-pagination
        v-model:current-page="page.query.mfaUserPage"
        v-model:page-size="page.query.mfaUserPageSize"
        v-pagination-label
        background
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        :total="page.mfaUserTotal"
        @current-change="page.handleMfaUserPageChange"
        @size-change="page.handleMfaUserPageSizeChange"
      />
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

const props = defineProps<{ page: SecurityPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.mfaUserItems,
  pageSize: () => props.page.query.mfaUserPageSize
});
</script>

<style scoped>
.v2-security-mfa-users__tools,
.v2-security-mfa-users__search {
  display: flex;
  align-items: center;
  gap: 12px;
}

.v2-security-mfa-users__title {
  display: grid;
  min-height: 96px;
  gap: 10px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-security-mfa-users__title .v2-section-heading,
.v2-security-mfa-users__title .v2-section-heading__actions {
  align-items: center;
}

.v2-security-mfa-users__title .v2-section-heading__actions,
.v2-security-mfa-users__tools > span {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 19.5px;
}

.v2-security-mfa-users__tools {
  justify-content: space-between;
}

.v2-security-mfa-users__search {
  width: min(320px, 100%);
}

.v2-security-mfa-users__mobile-wide {
  grid-column: 1 / -1;
}

@media (max-width: 760px) {
  .v2-security-mfa-users__tools {
    align-items: stretch;
    flex-direction: column;
  }

  .v2-security-mfa-users__search {
    width: 100%;
  }
}
</style>
