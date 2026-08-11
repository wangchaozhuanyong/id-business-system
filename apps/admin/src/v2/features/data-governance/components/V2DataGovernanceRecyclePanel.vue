<template>
  <section class="v2-governance-panel">
    <section class="v2-governance-command-panel" aria-label="回收站筛选与治理操作">
      <V2SectionHeading
        title="回收站筛选"
        help="筛选只影响当前回收站列表；生成恢复预览前必须勾选记录并确认审批条件。"
      >
        <template #actions>
          <span>已选择 {{ page.selectedRecycleItems.length }} 条</span>
        </template>
      </V2SectionHeading>

      <div class="v2-governance-filter-grid is-recycle">
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
        <div class="v2-governance-filter-grid__actions">
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
          <AppButton variant="ghost" :disabled="page.recycleLoading" @click="page.refreshRecycle">
            <el-icon><Refresh /></el-icon>
            刷新
          </AppButton>
        </div>
      </div>

      <footer>
        <p>
          <el-icon aria-hidden="true"><InfoFilled /></el-icon>
          恢复只恢复可见性或启用状态，不修改锁定订单、财务状态和既有审计证据。
        </p>
        <span>{{ page.recycleQueryModel.entity ? '已按类型筛选' : '当前显示全部类型' }}</span>
      </footer>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :phase="page.recycleQueryPhase"
      :previous-data="page.recycleParameterTransition"
      :error="page.recycleError"
      loading-title="正在读取回收站"
      refreshing-title="正在更新回收站"
      error-title="回收站加载失败"
      @retry="page.refreshRecycle"
    >
      <section ref="listRef" class="v2-records-list v2-governance-list" :style="listFrameStyle">
        <header class="v2-governance-list__header">
          <V2SectionHeading
            title="回收站记录"
            help="只显示当前系统支持恢复的软删除对象；恢复前仍需生成确定性影响预览。"
          >
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.dataGovernance.recycle" />
              <span>本页 {{ page.recycleItems.length }} 条</span>
              <span aria-hidden="true">·</span>
              <strong>共 {{ page.recycleTotal }} 条</strong>
            </template>
          </V2SectionHeading>
        </header>

        <V2Table
          :schema="v2TableSchemas.dataGovernance.recycle"
          :data="page.recycleItems"
          :show-column-settings="false"
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
                <strong
                  v-v2-column-visibility="[v2TableSchemas.dataGovernance.recycle.id, 'label']"
                >
                  {{ item.label }}
                </strong>
                <span v-v2-column-visibility="[v2TableSchemas.dataGovernance.recycle.id, '类型']">
                  {{ page.recycleEntityLabels[item.entity] }}
                </span>
              </div>
              <el-checkbox
                :model-value="page.isRecycleSelected(item)"
                aria-label="选择回收站记录"
                @change="page.toggleRecycleSelection(item, Boolean($event))"
              />
            </header>
            <dl>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.recycle.id, '删除时间']">
                <dt>删除时间</dt>
                <dd>{{ page.formatGovernanceDate(item.deletedAt) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.recycle.id, '恢复状态']">
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
import { InfoFilled, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ page: DataGovernancePage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.recycleItems,
  pageSize: () => props.page.recycleQueryModel.pageSize
});
</script>
