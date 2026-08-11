<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    :loading-title="page.activeTab === 'operations' ? '正在加载操作审计' : '正在加载敏感访问记录'"
    refreshing-title="正在更新审计日志"
    error-title="审计日志加载失败"
    @retry="page.refresh"
  >
    <section ref="listRef" class="v2-records-list v2-audit-list" :style="listFrameStyle">
      <header class="v2-audit-list__heading">
        <V2SectionHeading
          :title="page.activeTab === 'operations' ? '操作审计记录' : '敏感访问记录'"
        >
          <template #actions>
            <V2TableColumnSettings
              v-if="page.activeTab === 'operations'"
              inline
              :schema="v2TableSchemas.auditLogs.operations"
            />
            <V2TableColumnSettings
              v-else
              inline
              :schema="v2TableSchemas.auditLogs.sensitiveAccess"
            />
            <span>本页 {{ page.currentItems.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        v-if="page.activeTab === 'operations'"
        :schema="v2TableSchemas.auditLogs.operations"
        :show-column-settings="false"
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
            <span>{{
              page.activeFilterCount
                ? '当前筛选条件下没有数据'
                : '业务操作发生后会在这里留下可追溯记录'
            }}</span>
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
        :show-column-settings="false"
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
            <span>{{
              page.activeFilterCount
                ? '当前筛选条件下没有数据'
                : '查看受保护字段时会记录访问人、原因和审批状态'
            }}</span>
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
        <article v-for="item in page.currentItems" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong>{{ page.auditUserLabel(item.user) }}</strong>
              <span>{{ item.module }}</span>
              <span>{{ page.formatAuditDate(item.createdAt) }}</span>
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
            <div v-v2-column-visibility="[v2TableSchemas.auditLogs.operations.id, 'action']">
              <dt>动作</dt>
              <dd>{{ item.action }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.auditLogs.operations.id, '对象']">
              <dt>对象</dt>
              <dd>{{ page.operationObjectLabel(item) }}</dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.auditLogs.operations.id, 'remark']"
              class="v2-audit-mobile-wide"
            >
              <dt>说明</dt>
              <dd>{{ item.remark || '—' }}</dd>
            </div>
          </dl>
          <dl v-else>
            <div
              v-v2-column-visibility="[v2TableSchemas.auditLogs.sensitiveAccess.id, 'fieldName']"
            >
              <dt>敏感字段</dt>
              <dd>{{ item.fieldName }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.auditLogs.sensitiveAccess.id, '对象']">
              <dt>对象</dt>
              <dd>{{ page.sensitiveObjectLabel(item) }}</dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.auditLogs.sensitiveAccess.id, 'accessReason']"
              class="v2-audit-mobile-wide"
            >
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
        <div v-if="!page.currentItems.length" class="v2-records-empty">
          <strong>暂无审计记录</strong>
          <span>{{
            page.activeFilterCount ? '当前筛选条件下没有数据' : '尚未产生相关审计记录'
          }}</span>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ page.total }} 条</span>
        <el-pagination
          v-pagination-label
          :current-page="page.displayedPage"
          :page-size="page.displayedPageSize"
          background
          :disabled="page.isParameterTransition"
          :page-sizes="[10, 20, 50, 100]"
          layout="sizes, prev, pager, next"
          :total="page.total"
          @current-change="page.handlePageChange"
          @size-change="page.handlePageSizeChange"
        />
      </footer>
    </section>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

const props = defineProps<{ page: AuditLogsPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.currentItems,
  pageSize: () => props.page.displayedPageSize
});
</script>
