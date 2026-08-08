<template>
  <section class="v2-profile-sessions">
    <V2SectionHeading
      title="登录设备"
      help="只显示当前账号的在线会话。为防止误操作，当前设备需通过右上角账号菜单退出登录。"
    >
      <template #actions>
        <AppButton
          size="small"
          variant="danger"
          :disabled="!page.hasOtherActiveSessions"
          :loading="page.revokingOthers"
          @click="page.revokeOtherSessions"
        >
          退出其他设备
        </AppButton>
      </template>
    </V2SectionHeading>

    <div class="v2-records-list">
      <V2Table
        :schema="v2TableSchemas.profile.sessions"
        class="v2-records-table"
        :data="page.sessions"
        scrollbar-always-on
        show-overflow-tooltip
        :aria-busy="page.loading"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无在线设备</strong>
            <span>当前账号没有可显示的在线会话</span>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.profile.sessions.columns[0]" prop="userAgent">
          <template #default="{ row }">{{ page.profileClientSummary(row.userAgent) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.profile.sessions.columns[1]" prop="ip">
          <template #default="{ row }">{{ row.ip || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.profile.sessions.columns[2]">
          <template #default="{ row }">
            <el-tag :type="page.profileSessionStateMeta(row).type" effect="plain">
              {{ page.profileSessionStateMeta(row).label }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.profile.sessions.columns[3]" prop="lastActiveAt">
          <template #default="{ row }">{{ page.formatProfileDate(row.lastActiveAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.profile.sessions.columns[4]" prop="expiresAt">
          <template #default="{ row }">{{ page.formatProfileDate(row.expiresAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.profile.sessions.columns[5]">
          <template #default="{ row }">
            <AppButton
              size="small"
              variant="danger"
              :disabled="row.isCurrent || Boolean(row.revokedAt)"
              :loading="page.revokingSessionId === row.id"
              :title="row.isCurrent ? '当前设备请使用退出登录' : '退出这个设备'"
              @click="page.revokeSession(row)"
            >
              {{ row.isCurrent ? '当前设备' : '退出设备' }}
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.profile.sessions.id">
        <article v-for="item in page.sessions" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.profile.sessions.id, 'userAgent']">
                {{ page.profileClientSummary(item.userAgent) }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.profile.sessions.id, 'lastActiveAt']">
                最近活动 {{ page.formatProfileDate(item.lastActiveAt) }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.profile.sessions.id, '状态']"
              :type="page.profileSessionStateMeta(item).type"
              effect="plain"
            >
              {{ page.profileSessionStateMeta(item).label }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.profile.sessions.id, 'ip']">
              <dt>IP</dt>
              <dd>{{ item.ip || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.profile.sessions.id, 'expiresAt']">
              <dt>到期</dt>
              <dd>{{ page.formatProfileDate(item.expiresAt) }}</dd>
            </div>
          </dl>
          <AppButton
            v-if="!item.isCurrent && !item.revokedAt"
            size="small"
            variant="danger"
            :loading="page.revokingSessionId === item.id"
            @click="page.revokeSession(item)"
          >
            退出设备
          </AppButton>
        </article>
        <div v-if="!page.sessions.length" class="v2-records-empty">
          <strong>暂无在线设备</strong>
          <span>当前账号没有可显示的在线会话</span>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ page.sessionTotal }} 条</span>
        <el-pagination
          v-model:current-page="page.query.page"
          v-model:page-size="page.query.pageSize"
          v-pagination-label
          background
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next"
          :total="page.sessionTotal"
          @current-change="page.handlePageChange"
          @size-change="page.handlePageSizeChange"
        />
      </footer>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import type { useProfilePage } from '../useProfilePage';

type ProfilePage = UnwrapNestedRefs<ReturnType<typeof useProfilePage>>;

defineProps<{ page: ProfilePage }>();
</script>

<style scoped>
.v2-profile-sessions {
  display: grid;
  min-width: 0;
  gap: 12px;
}

@media (max-width: 620px) {
  .v2-profile-sessions :deep(.v2-section-heading) {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-profile-sessions :deep(.v2-section-heading__actions),
  .v2-profile-sessions :deep(.v2-section-heading__actions .app-button) {
    width: 100%;
  }
}
</style>
