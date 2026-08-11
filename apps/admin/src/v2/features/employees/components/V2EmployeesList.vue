<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载员工账户"
    refreshing-title="正在更新员工账户"
    error-title="员工账户加载失败"
    @retry="page.loadEmployees"
  >
    <section ref="listRef" class="v2-records-list v2-employees-list" :style="listFrameStyle">
      <header class="v2-employees-list__heading">
        <V2SectionHeading title="员工账户">
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.employees.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.employees.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无员工账户</strong>
            <span>{{
              page.activeFilterCount ? '当前筛选条件下没有数据' : '可开通第一个内部员工账号'
            }}</span>
            <AppButton variant="primary" @click="page.openCreate">开通员工</AppButton>
          </div>
        </template>

        <V2TableColumn
          :definition="v2TableSchemas.employees.main.columns[0]"
          prop="username"
          sortable="custom"
        >
          <template #default="{ row }"
            ><strong>{{ row.username }}</strong></template
          >
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.employees.main.columns[1]"
          prop="displayName"
          sortable="custom"
        />
        <V2TableColumn :definition="v2TableSchemas.employees.main.columns[2]">
          <template #default="{ row }">
            {{ row.roles.map((role: V2EmployeeRole) => role.name).join('、') || '—' }}
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.employees.main.columns[3]"
          prop="status"
          sortable="custom"
        >
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.employees.main.columns[4]">
          <template #default="{ row }">{{ row.activeSessionCount }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.employees.main.columns[5]">
          <template #default="{ row }">
            <el-tag :type="row.mustResetPassword ? 'warning' : 'success'" effect="plain">
              {{ row.mustResetPassword ? '待首次修改' : '正常' }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.employees.main.columns[6]"
          prop="lastLoginAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.lastLoginAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.employees.main.columns[7]">
          <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.employees.main.columns[8]"
          prop="createdAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.createdAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.employees.main.columns[9]">
          <template #default="{ row }">
            <AppButton size="small" variant="ghost" @click="page.openEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.employees.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.employees.main.id, 'displayName']">
                {{ item.displayName }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.employees.main.id, 'username']">
                {{ item.username }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.employees.main.id, 'status']"
              :type="item.status === 'active' ? 'success' : 'info'"
              effect="plain"
            >
              {{ item.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, '角色']">
              <dt>角色</dt>
              <dd>{{ item.roles.map((role) => role.name).join('、') || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, '在线会话']">
              <dt>在线会话</dt>
              <dd>{{ item.activeSessionCount }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, '密码状态']">
              <dt>密码状态</dt>
              <dd>{{ item.mustResetPassword ? '待首次修改' : '正常' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, 'lastLoginAt']">
              <dt>最近登录</dt>
              <dd>{{ page.formatDate(item.lastLoginAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, '操作人']">
              <dt>操作人</dt>
              <dd>{{ operatorUsername(item.createdBy) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.employees.main.id, 'createdAt']">
              <dt>开通时间</dt>
              <dd>{{ page.formatDate(item.createdAt) }}</dd>
            </div>
          </dl>
          <footer>
            <span />
            <AppButton size="small" variant="ghost" @click="page.openEdit(item)">
              <el-icon><Edit /></el-icon>
              编辑
            </AppButton>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无员工账户</strong>
          <span>{{
            page.activeFilterCount ? '当前筛选条件下没有数据' : '可开通第一个内部员工账号'
          }}</span>
          <AppButton variant="primary" @click="page.openCreate">开通员工</AppButton>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ page.total }} 条</span>
        <el-pagination
          v-pagination-label
          :current-page="page.displayedPage"
          :page-size="page.displayedPageSize"
          background
          :disabled="page.queryPhase === 'transitioning'"
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
import { Edit } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { operatorUsername } from '@/v2/utils/operator';
import type { V2EmployeeRole } from '../contracts';
import type { useEmployeesPage } from '../useEmployeesPage';

type EmployeesPage = UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;

const props = defineProps<{ page: EmployeesPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
