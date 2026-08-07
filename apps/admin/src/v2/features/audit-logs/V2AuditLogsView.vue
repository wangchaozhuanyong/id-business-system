<template>
  <section class="v2-records-page v2-audit-logs">
    <el-tabs
      v-model="page.activeTab"
      class="v2-audit-logs__tabs"
      @tab-change="page.handleTabChange"
    >
      <el-tab-pane label="操作审计" name="operations" />
      <el-tab-pane label="敏感访问" name="sensitive_access" />
    </el-tabs>

    <section class="v2-records-toolbar v2-audit-logs__toolbar" aria-label="审计日志筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="对象、说明、员工"
        aria-label="搜索审计日志"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-model="page.query.module"
        clearable
        placeholder="模块"
        aria-label="筛选审计模块"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-model="page.query.operator"
        clearable
        placeholder="操作人账号或姓名"
        aria-label="筛选操作人"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-if="page.activeTab === 'operations'"
        v-model="page.query.action"
        clearable
        placeholder="动作"
        aria-label="筛选审计动作"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-else
        v-model="page.query.fieldName"
        clearable
        placeholder="敏感字段"
        aria-label="筛选敏感字段"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <V2FilterDisclosure>
        <el-select
          v-if="page.activeTab === 'sensitive_access'"
          v-model="page.query.approved"
          clearable
          placeholder="全部审批状态"
          aria-label="筛选敏感访问审批状态"
          @change="page.handleSearch"
        >
          <el-option label="已批准" value="true" />
          <el-option label="未批准" value="false" />
        </el-select>
        <el-date-picker
          v-model="page.createdRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="筛选审计日期"
          @change="page.handleSearch"
        />
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
        <AppButton title="导出当前筛选" :loading="page.exporting" @click="page.exportCurrent">
          <el-icon><Download /></el-icon>
          导出
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading"
      :resolved="page.resolved"
      :error="page.listError"
      :loading-title="page.activeTab === 'operations' ? '正在加载操作审计' : '正在加载敏感访问记录'"
      refreshing-title="正在更新审计日志"
      error-title="审计日志加载失败"
      @retry="page.refresh"
    >
      <section class="v2-records-list">
        <V2Table
          v-if="page.activeTab === 'operations'"
          :schema="v2TableSchemas.auditLogs.operations"
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.operationItems"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无操作审计记录</strong>
              <span>业务操作发生后会在这里留下可追溯记录</span>
            </div>
          </template>
          <V2TableColumn :definition="v2TableSchemas.auditLogs.operations.columns[0]">
            <template #default="{ row }">{{ page.auditUserLabel(row.user) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.operations.columns[1]"
            prop="module"
            sortable="custom"
          />
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.operations.columns[2]"
            prop="action"
            sortable="custom"
          />
          <V2TableColumn :definition="v2TableSchemas.auditLogs.operations.columns[3]">
            <template #default="{ row }">{{ page.operationObjectLabel(row) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.operations.columns[4]"
            prop="remark"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{ row.remark || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.operations.columns[5]"
            prop="createdAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatAuditDate(row.createdAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.auditLogs.operations.columns[6]">
            <template #default="{ row }">
              <AppButton size="small" @click="page.openOperationDetails(row)">查看详情</AppButton>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <V2Table
          v-else
          :schema="v2TableSchemas.auditLogs.sensitiveAccess"
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.sensitiveItems"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无敏感访问记录</strong>
              <span>查看受保护字段时会记录访问人、原因和审批状态</span>
            </div>
          </template>
          <V2TableColumn :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[0]">
            <template #default="{ row }">{{ page.auditUserLabel(row.user) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[1]"
            prop="module"
            sortable="custom"
          />
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[2]"
            prop="fieldName"
            sortable="custom"
          />
          <V2TableColumn :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[3]">
            <template #default="{ row }">{{ page.sensitiveObjectLabel(row) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[4]"
            prop="approved"
            sortable="custom"
          >
            <template #default="{ row }">
              <el-tag :type="row.approved ? 'success' : 'warning'" effect="plain">
                {{ row.approved ? '已批准' : '未批准' }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[5]"
            prop="accessReason"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{ row.accessReason || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[6]"
            prop="createdAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatAuditDate(row.createdAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.auditLogs.sensitiveAccess.columns[7]">
            <template #default="{ row }">
              <AppButton size="small" @click="page.openSensitiveDetails(row)">查看详情</AppButton>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div
          class="v2-records-mobile-list"
          :data-mobile-for="
            page.activeTab === 'operations'
              ? v2TableSchemas.auditLogs.operations.id
              : v2TableSchemas.auditLogs.sensitiveAccess.id
          "
        >
          <article
            v-for="item in page.activeTab === 'operations'
              ? page.operationItems
              : page.sensitiveItems"
            :key="item.id"
            class="v2-records-mobile-item"
          >
            <header>
              <div>
                <strong>{{ page.auditUserLabel(item.user) }}</strong>
                <span>{{ item.module }} / {{ page.formatAuditDate(item.createdAt) }}</span>
              </div>
              <el-tag
                v-if="'approved' in item"
                :type="item.approved ? 'success' : 'warning'"
                effect="plain"
              >
                {{ item.approved ? '已批准' : '未批准' }}
              </el-tag>
              <el-tag v-else effect="plain">操作审计</el-tag>
            </header>
            <dl v-if="'action' in item">
              <div>
                <dt>动作</dt>
                <dd>{{ item.action }}</dd>
              </div>
              <div>
                <dt>对象</dt>
                <dd>{{ page.operationObjectLabel(item) }}</dd>
              </div>
              <div class="v2-audit-logs__mobile-wide">
                <dt>说明</dt>
                <dd>{{ item.remark || '—' }}</dd>
              </div>
            </dl>
            <dl v-else>
              <div>
                <dt>敏感字段</dt>
                <dd>{{ item.fieldName }}</dd>
              </div>
              <div>
                <dt>对象</dt>
                <dd>{{ page.sensitiveObjectLabel(item) }}</dd>
              </div>
              <div class="v2-audit-logs__mobile-wide">
                <dt>访问原因</dt>
                <dd>{{ item.accessReason || '—' }}</dd>
              </div>
            </dl>
            <AppButton
              size="small"
              @click="
                'action' in item ? page.openOperationDetails(item) : page.openSensitiveDetails(item)
              "
            >
              查看详情
            </AppButton>
          </article>
          <div
            v-if="
              !(page.activeTab === 'operations' ? page.operationItems : page.sensitiveItems).length
            "
            class="v2-records-empty"
          >
            <strong>暂无审计记录</strong>
            <span>当前筛选条件下没有数据</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ page.total }} 条</span>
          <el-pagination
            v-model:current-page="page.query.page"
            v-model:page-size="page.query.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="page.total"
            @current-change="page.handlePageChange"
            @size-change="page.handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2AuditLogDetailDrawer
      v-model="page.detailDrawerVisible"
      :selected-operation="page.selectedOperation"
      :selected-sensitive-access="page.selectedSensitiveAccess"
      @restore="page.openRestoreFromOperationAudit"
    />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Download, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2AuditLogDetailDrawer from './components/V2AuditLogDetailDrawer.vue';
import { useAuditLogsPage } from './useAuditLogsPage';
import '@/v2/styles/records.css';

const page = reactive(useAuditLogsPage());
</script>

<style scoped>
.v2-audit-logs__tabs {
  margin-bottom: 4px;
}

.v2-audit-logs__toolbar {
  grid-template-columns: repeat(4, minmax(150px, 1fr)) auto;
}

.v2-audit-logs__mobile-wide {
  grid-column: 1 / -1;
}

@media (max-width: 1100px) {
  .v2-audit-logs__toolbar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .v2-audit-logs__toolbar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
