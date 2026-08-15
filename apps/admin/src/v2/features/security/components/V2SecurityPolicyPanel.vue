<template>
  <section class="v2-security-policy">
    <div class="v2-security-policy__cards">
      <article>
        <header>
          <div>
            <span>管理员 MFA 策略</span>
            <strong>{{ page.mfaSettings?.value.enabled ? '已启用' : '未启用' }}</strong>
          </div>
          <el-tag :type="page.mfaSettings?.value.enabled ? 'success' : 'info'" effect="plain">
            {{ page.mfaSettings?.value.requiredForAdmins ? '管理员强制' : '非强制' }}
          </el-tag>
        </header>
        <dl>
          <div>
            <dt>签发方</dt>
            <dd>{{ page.mfaSettings?.value.issuer || '代充管理后台' }}</dd>
          </div>
          <div>
            <dt>恢复码数量</dt>
            <dd>{{ page.mfaSettings?.value.recoveryCodeCount ?? 10 }}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{{ page.formatSecurityDate(page.mfaSettings?.updatedAt) }}</dd>
          </div>
        </dl>
        <footer class="v2-security-policy__card-actions">
          <AppButton
            size="small"
            variant="ghost"
            @click="page.openPolicySettings(page.mfaSettings)"
          >
            编辑策略
          </AppButton>
        </footer>
      </article>
      <article>
        <header>
          <div>
            <span>当前管理员 MFA</span>
            <strong>{{ page.myMfaStatus?.enabled ? '已绑定' : '未绑定' }}</strong>
          </div>
          <el-tag :type="page.myMfaStatus?.enabled ? 'success' : 'warning'" effect="plain">
            {{ page.myMfaStatus?.configured ? '已配置密钥' : '未配置密钥' }}
          </el-tag>
        </header>
        <dl>
          <div>
            <dt>恢复码剩余</dt>
            <dd>{{ page.myMfaStatus?.recoveryCodeCount ?? 0 }}</dd>
          </div>
          <div>
            <dt>启用时间</dt>
            <dd>{{ page.formatSecurityDate(page.myMfaStatus?.enabledAt) }}</dd>
          </div>
          <div>
            <dt>最近使用</dt>
            <dd>{{ page.formatSecurityDate(page.myMfaStatus?.lastUsedAt) }}</dd>
          </div>
        </dl>
        <footer class="v2-security-policy__card-actions">
          <template v-if="page.myMfaStatus?.enabled">
            <AppButton size="small" variant="ghost" @click="page.regenerateRecoveryCodes">
              重新生成恢复码
            </AppButton>
            <AppButton size="small" variant="danger" @click="page.disableMyMfa">
              停用 MFA
            </AppButton>
          </template>
          <AppButton
            v-else
            size="small"
            variant="primary"
            :loading="page.mfaSetupLoading"
            @click="page.openMfaSetup"
          >
            绑定当前账号
          </AppButton>
        </footer>
      </article>
    </div>

    <div class="v2-security-policy__notice" role="note">
      <strong>高风险操作已启用防锁死校验</strong>
      <span>强制 MFA 会先检查启用管理员的绑定状态；白名单写操作会保留当前请求 IP。</span>
    </div>

    <V2SecurityMfaUsersPanel :page="page" />

    <section
      ref="whitelistListRef"
      class="v2-records-list v2-security-whitelist-list"
      :style="whitelistListFrameStyle"
    >
      <header class="v2-security-policy__table-title">
        <V2SectionHeading title="IP 白名单">
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.security.whitelist" />
            <span>本页 {{ page.whitelistItems.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
            <AppButton size="small" variant="primary" @click="page.openCreateWhitelist">
              新增白名单
            </AppButton>
          </template>
        </V2SectionHeading>
        <span>启用记录会在登录前执行，错误修改可能导致管理员无法进入系统。</span>
      </header>
      <V2Table
        :schema="v2TableSchemas.security.whitelist"
        :show-column-settings="false"
        class="v2-records-table"
        :data="page.whitelistItems"
        scrollbar-always-on
        show-overflow-tooltip
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无 IP 白名单</strong>
            <span>未配置启用记录时，不限制管理端和 API 登录 IP</span>
          </div>
        </template>
        <V2TableColumn
          :definition="v2TableSchemas.security.whitelist.columns[0]"
          prop="ipOrCidr"
          sortable="custom"
        />
        <V2TableColumn
          :definition="v2TableSchemas.security.whitelist.columns[1]"
          prop="scope"
          sortable="custom"
        >
          <template #default="{ row }">{{ row.scope === 'admin' ? '管理端' : 'API' }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.security.whitelist.columns[2]"
          prop="enabled"
          sortable="custom"
        >
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.security.whitelist.columns[3]"
          prop="remark"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ row.remark || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.security.whitelist.columns[4]">
          <template #default="{ row }">{{ page.securityUserLabel(row.createdBy) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.security.whitelist.columns[5]"
          prop="updatedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatSecurityDate(row.updatedAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.security.whitelist.columns[6]">
          <template #default="{ row }">
            <AppButton size="small" variant="ghost" @click="page.openEditWhitelist(row)">
              编辑
            </AppButton>
            <AppButton
              size="small"
              variant="danger"
              :loading="page.removingWhitelistId === row.id"
              @click="page.removeWhitelist(row)"
            >
              删除
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>
      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.security.whitelist.id">
        <article v-for="item in page.whitelistItems" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, 'ipOrCidr']">
                {{ item.ipOrCidr }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, 'scope']">
                {{ item.scope === 'admin' ? '管理端' : 'API' }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, 'enabled']"
              class="v2-status-tag"
              :type="item.enabled ? 'success' : 'info'"
              effect="plain"
            >
              {{ item.enabled ? '启用' : '停用' }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, '创建人']">
              <dt>创建人</dt>
              <dd>{{ page.securityUserLabel(item.createdBy) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, 'updatedAt']">
              <dt>更新时间</dt>
              <dd>{{ page.formatSecurityDate(item.updatedAt) }}</dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.security.whitelist.id, 'remark']"
              class="v2-security-policy__mobile-wide"
            >
              <dt>说明</dt>
              <dd>{{ item.remark || '—' }}</dd>
            </div>
          </dl>
          <footer class="v2-records-mobile-item__actions">
            <AppButton size="small" variant="ghost" @click="page.openEditWhitelist(item)">
              编辑
            </AppButton>
            <AppButton
              size="small"
              variant="danger"
              :loading="page.removingWhitelistId === item.id"
              @click="page.removeWhitelist(item)"
            >
              删除
            </AppButton>
          </footer>
        </article>
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
import V2SecurityMfaUsersPanel from './V2SecurityMfaUsersPanel.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

const props = defineProps<{ page: SecurityPage }>();
const { listRef: whitelistListRef, listFrameStyle: whitelistListFrameStyle } = useV2StableListFrame(
  {
    items: () => props.page.whitelistItems,
    pageSize: () => props.page.query.pageSize
  }
);
</script>

<style scoped>
.v2-security-policy,
.v2-security-policy__cards {
  display: grid;
  gap: 14px;
}

.v2-security-policy__cards {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.v2-security-policy__cards article {
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-security-policy__cards header,
.v2-security-policy__cards header > div {
  display: flex;
  align-items: center;
}

.v2-security-policy__cards header,
.v2-security-policy__cards header > div {
  align-items: baseline;
  gap: 10px;
}

.v2-security-policy__cards header span,
.v2-security-policy__cards dt,
.v2-security-policy__table-title span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-security-policy__cards header strong {
  font-size: 18px;
}

.v2-security-policy__cards dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0 0;
}

.v2-security-policy__cards dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}

.v2-security-policy__card-actions,
.v2-security-policy__table-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.v2-security-policy__card-actions {
  min-height: 44px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-security-policy__notice {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 11px 14px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: var(--v3-radius);
  background: var(--el-color-warning-light-9);
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-security-policy__notice strong {
  color: var(--el-color-warning-dark-2);
}

.v2-security-policy__table-title {
  display: grid;
  min-height: 76px;
  gap: 6px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-security-policy__table-title .v2-section-heading,
.v2-security-policy__table-title .v2-section-heading__actions {
  align-items: center;
}

.v2-security-policy__table-title .v2-section-heading__actions {
  font-size: 11px;
  line-height: 19.5px;
}

.v2-security-whitelist-list {
  min-height: 743px;
}

.v2-security-policy__mobile-wide {
  grid-column: 1 / -1;
}

@media (max-width: 760px) {
  .v2-security-policy__cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-security-policy__cards dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .v2-security-policy__table-title {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
