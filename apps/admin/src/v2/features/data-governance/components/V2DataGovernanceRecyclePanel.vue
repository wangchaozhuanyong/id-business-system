<template>
  <section class="v2-governance-panel">
    <el-alert
      v-if="page.previewBlockedReason"
      type="warning"
      :title="page.previewBlockedReason"
      :closable="false"
      show-icon
    />
    <div class="v2-records-toolbar v2-governance-toolbar">
      <el-select
        v-model="page.recycleQueryModel.entity"
        clearable
        placeholder="全部回收站类型"
        aria-label="筛选回收站类型"
        @change="page.handleRecycleFilterChange"
      >
        <el-option
          v-for="(label, value) in page.recycleEntityLabels"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <span>已选择 {{ page.selectedRecycleItems.length }} 条</span>
      <div class="v2-records-toolbar__actions">
        <AppButton
          variant="ghost"
          :disabled="Boolean(page.previewBlockedReason)"
          :title="page.previewBlockedReason || '生成汇率历史清理预览'"
          :aria-label="
            page.previewBlockedReason ? `生成清理预览：${page.previewBlockedReason}` : undefined
          "
          @click="page.openCleanupDrawer"
        >
          生成清理预览
        </AppButton>
        <AppButton
          variant="primary"
          :disabled="Boolean(page.previewBlockedReason)"
          :title="page.previewBlockedReason || '生成回收站恢复预览'"
          :aria-label="
            page.previewBlockedReason ? `生成恢复预览：${page.previewBlockedReason}` : undefined
          "
          @click="page.openRestoreDrawer"
        >
          生成恢复预览
        </AppButton>
        <AppButton
          icon-only
          title="刷新"
          :disabled="page.recycleLoading"
          @click="page.refreshRecycle"
        >
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </div>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.recycleLoading"
      :resolved="page.recycleHasData"
      :error="page.recycleError"
      loading-title="正在读取回收站"
      refreshing-title="正在更新回收站"
      error-title="回收站加载失败"
      @retry="page.refreshRecycle"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.dataGovernance.recycle"
          :data="page.recycleItems"
          class="v2-records-table"
          scrollbar-always-on
          @selection-change="page.handleRecycleSelection"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>回收站为空</strong>
              <span>当前筛选下没有软删除记录</span>
            </div>
          </template>
          <V2TableControlColumn :definition="v2TableSchemas.dataGovernance.recycle.columns[0]" />
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.recycle.columns[1]">
            <template #default="{ row }">{{ page.recycleEntityLabel(row.entity) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.dataGovernance.recycle.columns[2]"
            prop="label"
          />
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.recycle.columns[3]">
            <template #default="{ row }">{{ page.formatGovernanceDate(row.deletedAt) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.recycle.columns[4]">
            <template #default
              ><el-tag type="warning" effect="plain">需要影响预览</el-tag></template
            >
          </V2TableColumn>
        </V2Table>

        <div
          class="v2-records-mobile-list"
          :data-mobile-for="v2TableSchemas.dataGovernance.recycle.id"
        >
          <article
            v-for="item in page.recycleItems"
            :key="`${item.entity}:${item.id}`"
            class="v2-records-mobile-item"
          >
            <header>
              <div>
                <strong>{{ item.label }}</strong>
                <span>{{ page.recycleEntityLabels[item.entity] }}</span>
              </div>
              <el-checkbox
                :model-value="page.isRecycleSelected(item)"
                aria-label="选择回收站记录"
                @change="page.toggleRecycleSelection(item, Boolean($event))"
              />
            </header>
            <dl>
              <div>
                <dt>删除时间</dt>
                <dd>{{ page.formatGovernanceDate(item.deletedAt) }}</dd>
              </div>
              <div>
                <dt>恢复状态</dt>
                <dd>需要影响预览</dd>
              </div>
            </dl>
          </article>
          <div v-if="!page.recycleItems.length" class="v2-records-empty">
            <strong>回收站为空</strong>
            <span>当前筛选下没有软删除记录</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>当前筛选共 {{ page.recycleTotal }} 条</span>
          <el-pagination
            v-model:current-page="page.recycleQueryModel.page"
            v-model:page-size="page.recycleQueryModel.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="page.recycleTotal"
            @current-change="page.refreshRecycle"
            @size-change="page.handleRecycleFilterChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

defineProps<{ page: DataGovernancePage }>();
</script>

<style scoped>
.v2-governance-panel {
  display: grid;
  gap: 14px;
}

.v2-governance-toolbar {
  grid-template-columns: minmax(180px, 240px) auto 1fr;
}

.v2-governance-toolbar > span {
  align-self: center;
  color: var(--v2-text-soft);
  font-size: 12px;
}

@media (max-width: 760px) {
  .v2-governance-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
