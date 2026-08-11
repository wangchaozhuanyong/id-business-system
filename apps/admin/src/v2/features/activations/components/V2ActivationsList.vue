<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载开通记录"
    refreshing-title="正在更新开通记录"
    error-title="开通记录加载失败"
    @retry="page.loadActivations"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-activation-list__header">
        <V2SectionHeading
          title="开通记录列表"
          help="记录由完成扣款并确认开通的订单生成；点击详情查看完整业务快照。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.activations.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.activations.main"
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
            <strong>暂无开通记录</strong>
            <span>只有完成扣款并确认开通的订单才会出现在这里</span>
          </div>
        </template>

        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[0]">
          <template #default="{ row }">
            <strong class="v2-activation-order">{{ row.order.orderNo }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[1]">
          <template #default="{ row }">{{ row.customer.name }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[2]">
          <template #default="{ row }">{{ row.service.name }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[3]">
          <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[4]">
          <template #default="{ row }">{{ row.maskedWebsiteAccount || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.activations.main.columns[5]"
          prop="openedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.openedAt) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.activations.main.columns[6]"
          prop="dueAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.dueAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[7]">
          <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.activations.main.columns[8]" prop="status">
          <template #default="{ row }">
            <el-tag :type="page.statusType(row.status.code)" effect="plain">
              {{ row.status.label }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.activations.main.columns[9]">
          <template #default="{ row }">
            <AppButton size="small" variant="ghost" @click="page.openDetail(row)">
              <el-icon><View /></el-icon>
              详情
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.activations.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.activations.main.id, '订单']">
                {{ item.order.orderNo }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.activations.main.id, '客户']">
                {{ item.customer.name }}
              </span>
              <span v-v2-column-visibility="[v2TableSchemas.activations.main.id, '业务']">
                {{ item.service.name }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.activations.main.id, 'status']"
              :type="page.statusType(item.status.code)"
              effect="plain"
            >
              {{ item.status.label }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.activations.main.id, '苹果 ID']">
              <dt>苹果 ID</dt>
              <dd>{{ item.account.appleIdMasked }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.activations.main.id, '客户网站账号']">
              <dt>客户网站账号</dt>
              <dd>{{ item.maskedWebsiteAccount || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.activations.main.id, 'openedAt']">
              <dt>开通日期</dt>
              <dd>{{ page.formatDate(item.openedAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.activations.main.id, 'dueAt']">
              <dt>到期日期</dt>
              <dd>{{ page.formatDate(item.dueAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.activations.main.id, '操作人']">
              <dt>操作人</dt>
              <dd>{{ operatorUsername(item.createdBy) }}</dd>
            </div>
          </dl>
          <footer>
            <span />
            <AppButton size="small" variant="ghost" @click="page.openDetail(item)">
              <el-icon><View /></el-icon>
              详情
            </AppButton>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无开通记录</strong>
          <span>当前筛选条件下没有数据</span>
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
import { View } from '@element-plus/icons-vue';
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
import type { useActivationsPage } from '../useActivationsPage';

type ActivationsPage = UnwrapNestedRefs<ReturnType<typeof useActivationsPage>>;

const props = defineProps<{
  page: ActivationsPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
