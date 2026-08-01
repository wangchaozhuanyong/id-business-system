<template>
  <section class="v2-records-page v2-roles-page">
    <section class="v2-records-toolbar v2-roles-toolbar" aria-label="角色权限筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="角色名称、编码或说明"
        aria-label="搜索角色"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadRoles">
          <el-icon><Refresh /></el-icon>
        </AppButton>
        <AppButton variant="primary" @click="page.openCreate">
          <el-icon><Plus /></el-icon>
          新建角色
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading || page.isInitialLoading"
      :resolved="page.hasLoadedOnce"
      :error="page.listError"
      loading-title="正在加载角色权限"
      refreshing-title="正在更新角色权限"
      error-title="角色权限加载失败"
      @retry="page.loadRoles"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.roles.main"
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.items"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无角色</strong>
              <span>可创建第一个业务角色并分配权限</span>
              <AppButton variant="primary" @click="page.openCreate">新建角色</AppButton>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.roles.main.columns[0]"
            prop="name"
            sortable="custom"
          >
            <template #default="{ row }">
              <div class="v2-role-name">
                <strong>{{ row.name }}</strong>
                <el-tag v-if="row.isSystemRole" type="info" effect="plain">系统</el-tag>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.roles.main.columns[1]"
            prop="code"
            sortable="custom"
          />
          <V2TableColumn :definition="v2TableSchemas.roles.main.columns[2]" prop="description">
            <template #default="{ row }">{{ row.description || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.roles.main.columns[3]">
            <template #default="{ row }">{{ row.permissionCount }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.roles.main.columns[4]">
            <template #default="{ row }">{{ row.memberCount }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.roles.main.columns[5]"
            prop="updatedAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatDate(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.roles.main.columns[6]">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="page.openEdit(row)">
                <el-icon>
                  <View v-if="row.isSystemRole" />
                  <Edit v-else />
                </el-icon>
                {{ row.isSystemRole ? '查看' : '编辑' }}
              </AppButton>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.roles.main.id">
          <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.name }}</strong>
                <span>{{ item.code }}</span>
              </div>
              <el-tag v-if="item.isSystemRole" type="info" effect="plain">系统</el-tag>
            </header>
            <dl>
              <div>
                <dt>角色说明</dt>
                <dd>{{ item.description || '—' }}</dd>
              </div>
              <div>
                <dt>权限数量</dt>
                <dd>{{ item.permissionCount }}</dd>
              </div>
              <div>
                <dt>成员数量</dt>
                <dd>{{ item.memberCount }}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{{ page.formatDate(item.updatedAt) }}</dd>
              </div>
            </dl>
            <footer>
              <span />
              <AppButton size="small" variant="ghost" @click="page.openEdit(item)">
                <el-icon>
                  <View v-if="item.isSystemRole" />
                  <Edit v-else />
                </el-icon>
                {{ item.isSystemRole ? '查看' : '编辑' }}
              </AppButton>
            </footer>
          </article>
          <div v-if="!page.items.length" class="v2-records-empty">
            <strong>暂无角色</strong>
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

    <V2RoleDrawer :page="page" />
  </section>
</template>

<script setup lang="ts">
import { Edit, Plus, Refresh, RefreshLeft, Search, View } from '@element-plus/icons-vue';
import { reactive } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2RoleDrawer from './components/V2RoleDrawer.vue';
import { useRolesPage } from './useRolesPage';
import '@/v2/styles/records.css';

const page = reactive(useRolesPage());
</script>

<style scoped>
.v2-roles-toolbar {
  grid-template-columns: minmax(240px, 1fr) auto;
}

.v2-role-name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

@media (max-width: 640px) {
  .v2-roles-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
