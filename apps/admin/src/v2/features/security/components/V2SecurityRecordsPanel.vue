<template>
  <section ref="listRef" class="v2-records-list v2-security-records" :style="listFrameStyle">
    <header class="v2-security-records__heading">
      <V2SectionHeading :title="page.activeTab === 'login_logs' ? '登录记录' : '在线会话'">
        <template #actions>
          <V2TableColumnSettings
            v-if="page.activeTab === 'login_logs'"
            inline
            :schema="v2TableSchemas.security.loginLogs"
          />
          <V2TableColumnSettings v-else inline :schema="v2TableSchemas.security.sessions" />
          <span>本页 {{ page.currentItems.length }} 条</span>
          <span aria-hidden="true">·</span>
          <strong>共 {{ page.total }} 条</strong>
        </template>
      </V2SectionHeading>
    </header>
    <V2Table
      v-if="page.activeTab === 'login_logs'"
      :schema="v2TableSchemas.security.loginLogs"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.loginItems"
      scrollbar-always-on
      show-overflow-tooltip
      :aria-busy="page.loading"
      @sort-change="page.handleSortChange"
    >
      <template #empty>
        <div class="v2-records-empty">
          <strong>暂无登录记录</strong>
          <span>登录成功、失败或被拦截后会显示在这里</span>
        </div>
      </template>
      <V2TableColumn :definition="v2TableSchemas.security.loginLogs.columns[0]">
        <template #default="{ row }">{{ page.securityUserLabel(row.user, row.username) }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[1]"
        prop="status"
        sortable="custom"
      >
        <template #default="{ row }">
          <el-tag :type="page.loginStatusMeta(row.status).type" effect="plain">
            {{ page.loginStatusMeta(row.status).label }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[2]"
        prop="abnormal"
        sortable="custom"
      >
        <template #default="{ row }">
          <el-tag :type="row.abnormal ? 'danger' : 'info'" effect="plain">
            {{ page.loginRiskLabel(row) }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[3]"
        prop="ip"
        sortable="custom"
      >
        <template #default="{ row }">{{ row.ip || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[4]"
        prop="failureReason"
        show-overflow-tooltip
      >
        <template #default="{ row }">{{ row.failureReason || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[5]"
        prop="userAgent"
        show-overflow-tooltip
      >
        <template #default="{ row }">{{ page.clientSummary(row.userAgent) }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.loginLogs.columns[6]"
        prop="createdAt"
        sortable="custom"
      >
        <template #default="{ row }">{{ page.formatSecurityDate(row.createdAt) }}</template>
      </V2TableColumn>
    </V2Table>

    <V2Table
      v-else
      :schema="v2TableSchemas.security.sessions"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.sessionItems"
      scrollbar-always-on
      show-overflow-tooltip
      :aria-busy="page.loading"
      @sort-change="page.handleSortChange"
    >
      <template #empty>
        <div class="v2-records-empty">
          <strong>暂无会话记录</strong>
          <span>当前筛选条件下没有在线或历史会话</span>
        </div>
      </template>
      <V2TableColumn :definition="v2TableSchemas.security.sessions.columns[0]">
        <template #default="{ row }">{{ page.securityUserLabel(row.user) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.security.sessions.columns[1]">
        <template #default="{ row }">
          <el-tag :type="page.sessionStateMeta(row).type" effect="plain">
            {{ page.sessionStateMeta(row).label }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.sessions.columns[2]"
        prop="ip"
        sortable="custom"
      >
        <template #default="{ row }">{{ row.ip || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.sessions.columns[3]"
        prop="userAgent"
        show-overflow-tooltip
      >
        <template #default="{ row }">{{ page.clientSummary(row.userAgent) }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.sessions.columns[4]"
        prop="lastActiveAt"
        sortable="custom"
      >
        <template #default="{ row }">{{ page.formatSecurityDate(row.lastActiveAt) }}</template>
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.security.sessions.columns[5]"
        prop="expiresAt"
        sortable="custom"
      >
        <template #default="{ row }">{{ page.formatSecurityDate(row.expiresAt) }}</template>
      </V2TableColumn>
      <V2TableActionColumn :definition="v2TableSchemas.security.sessions.columns[6]">
        <template #default="{ row }">
          <AppButton
            size="small"
            variant="danger"
            :disabled="row.isCurrent || Boolean(row.revokedAt)"
            :loading="page.revokingSessionId === row.id"
            :title="row.isCurrent ? '当前会话不能在此处强制下线' : '强制下线这个会话'"
            @click="page.revokeSession(row)"
          >
            {{ row.isCurrent ? '当前设备' : '强制下线' }}
          </AppButton>
        </template>
      </V2TableActionColumn>
    </V2Table>

    <div
      class="v2-records-mobile-list"
      :data-mobile-for="
        page.activeTab === 'login_logs'
          ? v2TableSchemas.security.loginLogs.id
          : v2TableSchemas.security.sessions.id
      "
    >
      <article
        v-for="item in page.activeTab === 'login_logs' ? page.loginItems : page.sessionItems"
        :key="item.id"
        class="v2-records-mobile-item"
      >
        <template v-if="'status' in item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, '用户']">
                {{ page.securityUserLabel(item.user, item.username) }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, 'createdAt']">
                {{ page.formatSecurityDate(item.createdAt) }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, 'status']"
              class="v2-status-tag"
              :type="page.loginStatusMeta(item.status).type"
              effect="plain"
            >
              {{ page.loginStatusMeta(item.status).label }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, 'abnormal']">
              <dt>风险</dt>
              <dd>{{ page.loginRiskLabel(item) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, 'ip']">
              <dt>IP</dt>
              <dd>{{ item.ip || '—' }}</dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.security.loginLogs.id, 'failureReason']"
              class="v2-security-mobile-wide"
            >
              <dt>失败原因</dt>
              <dd>{{ item.failureReason || '—' }}</dd>
            </div>
          </dl>
        </template>
        <template v-else>
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.security.sessions.id, '用户']">
                {{ page.securityUserLabel(item.user) }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.security.sessions.id, 'lastActiveAt']">
                最近活动 {{ page.formatSecurityDate(item.lastActiveAt) }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.security.sessions.id, '状态']"
              class="v2-status-tag"
              :type="page.sessionStateMeta(item).type"
              effect="plain"
            >
              {{ page.sessionStateMeta(item).label }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.security.sessions.id, 'ip']">
              <dt>IP</dt>
              <dd>{{ item.ip || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.security.sessions.id, 'expiresAt']">
              <dt>到期</dt>
              <dd>{{ page.formatSecurityDate(item.expiresAt) }}</dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.security.sessions.id, 'userAgent']"
              class="v2-security-mobile-wide"
            >
              <dt>客户端</dt>
              <dd>{{ page.clientSummary(item.userAgent) }}</dd>
            </div>
          </dl>
          <AppButton
            v-if="!item.isCurrent && !item.revokedAt"
            size="small"
            variant="danger"
            :loading="page.revokingSessionId === item.id"
            @click="page.revokeSession(item)"
          >
            强制下线
          </AppButton>
        </template>
      </article>
      <div
        v-if="!(page.activeTab === 'login_logs' ? page.loginItems : page.sessionItems).length"
        class="v2-records-empty"
      >
        <strong>暂无安全记录</strong>
        <span>当前筛选条件下没有数据</span>
      </div>
    </div>

    <footer class="v2-records-pagination">
      <span>共 {{ page.total }} 条</span>
      <el-pagination
        v-pagination-label
        :current-page="page.displayedPage"
        :page-size="page.displayedPageSize"
        background
        :page-sizes="[10, 20, 50, 100]"
        layout="sizes, prev, pager, next"
        :total="page.total"
        :disabled="page.queryPhase === 'transitioning'"
        @current-change="page.handlePageChange"
        @size-change="page.handlePageSizeChange"
      />
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

const props = defineProps<{ page: SecurityPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.currentItems,
  pageSize: () => props.page.query.pageSize
});
</script>

<style scoped>
.v2-security-mobile-wide {
  grid-column: 1 / -1;
}
</style>
