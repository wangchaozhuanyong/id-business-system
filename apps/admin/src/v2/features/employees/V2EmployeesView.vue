<template>
  <section class="v2-records-page v2-employees-page">
    <section class="v2-records-toolbar v2-employees-toolbar" aria-label="员工账户筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="登录账号、员工姓名"
        aria-label="搜索员工账户"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.status"
        clearable
        placeholder="全部状态"
        aria-label="筛选员工账号状态"
        @change="page.handleFilterChange"
      >
        <el-option label="启用" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-select
        v-model="page.query.roleId"
        clearable
        filterable
        placeholder="全部角色"
        aria-label="筛选员工角色"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="role in page.roleOptions"
          :key="role.id"
          :label="role.name"
          :value="role.id"
        />
      </el-select>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadEmployees">
          <el-icon><Refresh /></el-icon>
        </AppButton>
        <AppButton variant="primary" @click="page.openCreate">
          <el-icon><Plus /></el-icon>
          开通员工
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading || page.isInitialLoading"
      :resolved="page.hasLoadedOnce"
      :error="page.listError"
      loading-title="正在加载员工账户"
      refreshing-title="正在更新员工账户"
      error-title="员工账户加载失败"
      @retry="page.loadEmployees"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.employees.main"
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
              <span>可由管理员开通第一个内部员工账号</span>
              <AppButton variant="primary" @click="page.openCreate">开通员工</AppButton>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.employees.main.columns[0]"
            prop="username"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong>{{ row.username }}</strong>
            </template>
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
                <strong>{{ item.displayName }}</strong>
                <span>{{ item.username }}</span>
              </div>
              <el-tag :type="item.status === 'active' ? 'success' : 'info'" effect="plain">
                {{ item.status === 'active' ? '启用' : '停用' }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>角色</dt>
                <dd>{{ item.roles.map((role) => role.name).join('、') || '—' }}</dd>
              </div>
              <div>
                <dt>在线会话</dt>
                <dd>{{ item.activeSessionCount }}</dd>
              </div>
              <div>
                <dt>密码状态</dt>
                <dd>{{ item.mustResetPassword ? '待首次修改' : '正常' }}</dd>
              </div>
              <div>
                <dt>最近登录</dt>
                <dd>{{ page.formatDate(item.lastLoginAt) }}</dd>
              </div>
              <div>
                <dt>操作人</dt>
                <dd>{{ operatorUsername(item.createdBy) }}</dd>
              </div>
              <div>
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

    <V2EmployeeDrawer :page="page" />
  </section>
</template>

<script setup lang="ts">
import { Edit, Plus, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import { reactive } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { operatorUsername } from '@/v2/utils/operator';
import V2EmployeeDrawer from './components/V2EmployeeDrawer.vue';
import type { V2EmployeeRole } from './contracts';
import { useEmployeesPage } from './useEmployeesPage';
import '@/v2/styles/records.css';

const page = reactive(useEmployeesPage());
</script>

<style scoped>
.v2-employees-toolbar {
  grid-template-columns: minmax(220px, 1fr) minmax(136px, 0.45fr) minmax(160px, 0.55fr) auto;
}

@media (max-width: 980px) {
  .v2-employees-toolbar {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 640px) {
  .v2-employees-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
