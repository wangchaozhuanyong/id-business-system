<template>
  <section ref="listRef" class="v2-records-list v2-options-list" :style="listFrameStyle">
      <header class="v2-options-list__header">
        <V2SectionHeading
          :title="`${page.activeTypeDefinition?.label ?? '选项'}列表`"
          help="列设置、排序、编辑和删除均保留原有行为；系统固定记录只读。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.options.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :key="page.renderedType"
        :schema="v2TableSchemas.options.main"
        :view-key="page.renderedType"
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
            <strong>暂无{{ page.activeTypeDefinition?.label ?? '选项' }}</strong>
            <span>当前筛选条件下没有数据</span>
            <AppButton variant="primary" @click="page.openCreate">
              <el-icon><Plus /></el-icon>
              新增{{ page.activeTypeDefinition?.label ?? '选项' }}
            </AppButton>
          </div>
        </template>

        <V2TableColumn
          :definition="v2TableSchemas.options.main.columns[0]"
          prop="name"
          sortable="custom"
        >
          <template #default="{ row }">
            <strong class="v2-table-cell">{{ row.name }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.options.main.columns[1]"
          prop="remark"
          show-overflow-tooltip
        />
        <V2TableColumn
          v-if="page.activeTypeDefinition?.parentType"
          :definition="v2TableSchemas.options.main.columns[2]"
        >
          <template #default="{ row }">{{ row.parent?.name ?? '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          v-if="page.activeTypeDefinition?.requiresCountry"
          :definition="v2TableSchemas.options.main.columns[3]"
        >
          <template #default="{ row }">{{ row.country?.name ?? '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          v-if="page.activeTypeDefinition?.supportsBusinessAmount"
          :definition="v2TableSchemas.options.main.columns[4]"
        >
          <template #default="{ row }">
            {{ page.formatDecimal(row.businessAmount ?? '0') }} {{ row.currencyCode ?? '—' }}
          </template>
        </V2TableColumn>
        <V2TableColumn
          v-if="page.activeTypeDefinition?.supportsCurrency"
          :definition="v2TableSchemas.options.main.columns[5]"
        >
          <template #default="{ row }">{{ row.currencyCode ?? '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          v-if="page.activeTypeDefinition?.supportsFees"
          :definition="v2TableSchemas.options.main.columns[6]"
        >
          <template #default="{ row }">¥{{ page.formatDecimal(row.fixedFee) }}</template>
        </V2TableColumn>
        <V2TableColumn
          v-if="page.activeTypeDefinition?.supportsFees"
          :definition="v2TableSchemas.options.main.columns[7]"
        >
          <template #default="{ row }">{{ page.formatDecimal(row.percentageFee) }}%</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.options.main.columns[8]"
          prop="sortOrder"
          sortable="custom"
        />
        <V2TableColumn :definition="v2TableSchemas.options.main.columns[9]">
          <template #default="{ row }">
            <el-tag v-if="row.isSystem" type="warning" effect="plain">系统固定</el-tag>
            <span v-else>—</span>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.options.main.columns[10]"
          prop="status"
          sortable="custom"
        >
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.options.main.columns[11]"
          prop="updatedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.updatedAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.options.main.columns[12]">
          <template #default="{ row }">
            <AppButton
              size="small"
              variant="ghost"
              :disabled="row.isSystem"
              :title="row.isSystem ? '系统固定选项不能编辑' : '编辑选项'"
              @click="page.openEdit(row)"
            >
              <el-icon><Edit /></el-icon>
              编辑
            </AppButton>
            <AppButton
              size="small"
              variant="danger"
              :disabled="row.isSystem"
              :title="page.getDeleteTitle(row)"
              @click="page.openDelete(row)"
            >
              <el-icon><Delete /></el-icon>
              删除
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <footer class="v2-records-pagination">
        <span
          >共 {{ page.total }} 条 · 当前分类 {{ page.activeTypeDefinition?.label ?? '选项' }}</span
        >
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
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Delete, Edit, Plus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useOptionsPage } from '../useOptionsPage';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

const props = defineProps<{
  page: OptionsPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
