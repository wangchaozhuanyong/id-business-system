<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载角色权限"
    refreshing-title="正在更新角色权限"
    error-title="角色权限加载失败"
    @retry="page.loadRoles"
  >
    <section ref="listRef" class="v2-records-list v2-roles-list" :style="listFrameStyle">
      <header class="v2-roles-list__heading">
        <V2SectionHeading title="角色清单">
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.roles.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.roles.main"
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
            <strong>暂无角色</strong>
            <span>{{
              page.activeFilterCount ? '当前筛选条件下没有数据' : '可创建第一个业务角色并分配权限'
            }}</span>
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
              <el-icon><View v-if="row.isSystemRole" /><Edit v-else /></el-icon>
              {{ row.isSystemRole ? '查看' : '编辑' }}
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.roles.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.roles.main.id, 'name']">
                {{ item.name }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.roles.main.id, 'code']">
                {{ item.code }}
              </span>
            </div>
            <el-tag v-if="item.isSystemRole" type="info" effect="plain">系统</el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.roles.main.id, 'description']">
              <dt>角色说明</dt>
              <dd>{{ item.description || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.roles.main.id, '权限数量']">
              <dt>权限数量</dt>
              <dd>{{ item.permissionCount }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.roles.main.id, '成员数量']">
              <dt>成员数量</dt>
              <dd>{{ item.memberCount }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.roles.main.id, 'updatedAt']">
              <dt>更新时间</dt>
              <dd>{{ page.formatDate(item.updatedAt) }}</dd>
            </div>
          </dl>
          <footer>
            <span />
            <AppButton size="small" variant="ghost" @click="page.openEdit(item)">
              <el-icon><View v-if="item.isSystemRole" /><Edit v-else /></el-icon>
              {{ item.isSystemRole ? '查看' : '编辑' }}
            </AppButton>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无角色</strong>
          <span>{{
            page.activeFilterCount ? '当前筛选条件下没有数据' : '可创建第一个业务角色并分配权限'
          }}</span>
          <AppButton variant="primary" @click="page.openCreate">新建角色</AppButton>
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
import { Edit, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useRolesPage } from '../useRolesPage';

type RolesPage = UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;

const props = defineProps<{ page: RolesPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
