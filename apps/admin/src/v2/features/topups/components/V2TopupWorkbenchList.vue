<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载加卡工作台"
    refreshing-title="正在更新加卡工作台"
    error-title="加卡工作台加载失败"
    @retry="page.loadWorkbench"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-topup-list__header">
        <el-tabs
          :model-value="page.activeList"
          class="v2-topup-list-tabs"
          aria-label="可加卡 ID 销售分类"
          @tab-change="page.changeAccountList"
        >
          <el-tab-pane label="未售出 ID" name="available" />
          <el-tab-pane label="已售出 ID" name="sold" />
        </el-tabs>
        <div class="v2-topup-list__tools">
          <V2TableColumnSettings
            v-if="page.activeList === 'available'"
            inline
            :schema="v2TableSchemas.topups.available"
          />
          <V2TableColumnSettings v-else inline :schema="v2TableSchemas.topups.sold" />
          <span>本页 {{ page.items.length }} 条</span>
          <span aria-hidden="true">·</span>
          <strong>共 {{ page.total }} 条</strong>
        </div>
      </header>

      <V2TopupAvailableTable v-if="page.activeList === 'available'" :page="page" />
      <V2TopupSoldTable v-else :page="page" />

      <footer class="v2-records-pagination">
        <span>
          共 {{ page.total }} 条
          <template v-if="page.evaluatedAt">
            · 当前业务计算于 {{ page.formatTime(page.evaluatedAt) }}
          </template>
        </span>
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
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TopupAvailableTable from './V2TopupAvailableTable.vue';
import V2TopupSoldTable from './V2TopupSoldTable.vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
