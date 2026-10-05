<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载订单"
    refreshing-title="正在更新订单"
    error-title="订单加载失败"
    @retry="page.loadOrders"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-orders-list__header">
        <V2SectionHeading title="订单列表" help="可横向查看完整字段，固定操作列始终保留在右侧。">
          <template #actions>
            <AppButton
              v-if="page.canUpdateOrders && page.archive.selectedCount"
              variant="primary"
              :disabled="page.isParameterTransition || page.archive.saving"
              @click="page.archive.openSelected"
            >
              归档所选（{{ page.archive.selectedCount }}）
            </AppButton>
            <AppButton
              v-if="page.archive.selectedCount"
              variant="ghost"
              :disabled="page.archive.saving"
              @click="page.archive.clearSelection"
              >清除选择</AppButton
            >
            <V2TableColumnSettings inline :schema="v2TableSchemas.orders.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>
      <V2Table
        :schema="v2TableSchemas.orders.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        :default-sort="{ prop: 'openedAt', order: 'descending' }"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无订单</strong>
            <span>{{ page.hasActiveFilters ? '当前筛选条件下没有数据' : '系统中暂无订单' }}</span>
            <AppButton
              v-if="page.canConsumeOrders"
              size="small"
              variant="primary"
              @click="page.openOrderEntry"
            >
              录入新订单
            </AppButton>
          </div>
        </template>

        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[0]"
          prop="orderNo"
          sortable="custom"
        >
          <template #default="{ row }">
            <el-checkbox
              v-if="
                page.canUpdateOrders &&
                (page.archive.canArchive(row) || page.archive.isSelected(row))
              "
              :model-value="page.archive.isSelected(row)"
              :disabled="page.isParameterTransition || page.archive.saving"
              :aria-label="`选择归档订单 ${row.orderNo}`"
              @change="page.archive.select(row, $event)"
              ><span class="visually-hidden">选择归档订单 {{ row.orderNo }}</span></el-checkbox
            >
            <strong class="v2-order-number v2-table-cell">{{ row.orderNo }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[1]"
          prop="createdAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.createdAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[2]">
          <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[3]">
          <template #default="{ row }">
            <strong class="v2-table-cell">{{ row.customer.name }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[4]">
          <template #default="{ row }">{{ row.service.parent?.name || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[5]">
          <template #default="{ row }">{{ row.service.name }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[6]" show-overflow-tooltip>
          <template #default="{ row }">
            <div>
              <strong class="v2-table-cell">{{ row.account?.displayAppleId || '—' }}</strong>
              <el-tag v-if="row.accountSource === 'customer_owned'" type="warning" effect="plain">
                客户已购
              </el-tag>
              <small v-if="row.sourceSoldOrder">
                {{ row.sourceSoldOrder.orderNo }} · {{ row.sourceSoldOrder.customer.name }}
              </small>
            </div>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[7]"
          prop="accountDisposition"
          sortable="custom"
        >
          <template #default="{ row }">
            <el-tag
              :type="page.accountDispositionMeta(row.accountDisposition, row.status).type"
              effect="plain"
            >
              {{ page.accountDispositionMeta(row.accountDisposition, row.status).label }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[8]"
          prop="accountCostAmount"
          sortable="custom"
        >
          <template #default="{ row }">
            ¥{{ page.formatDecimal(row.appliedAccountCostAmount) }}
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[9]" show-overflow-tooltip>
          <template #default="{ row }">{{ row.displayWebsiteAccount || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[10]"
          prop="receivedAmount"
          sortable="custom"
        >
          <template #default="{ row }">¥{{ page.formatDecimal(row.receivedAmount) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[11]"
          prop="profitAmount"
          sortable="custom"
        >
          <template #default="{ row }">
            <strong :class="page.profitClass(row.profitAmount)">
              ¥{{ page.formatNullableDecimal(row.profitAmount) }}
            </strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.orders.main.columns[12]">
          <template #default="{ row }">
            <strong :class="page.profitClass(row.profitRate)">
              {{ row.profitRate === null ? '—' : `${page.formatDecimal(row.profitRate)}%` }}
            </strong>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[13]"
          prop="openedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.openedAt) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[14]"
          prop="dueAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.dueAt) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.orders.main.columns[15]"
          prop="status"
          sortable="custom"
        >
          <template #default="{ row }">
            <div class="v2-order-progress">
              <el-tag v-if="row.archivedAt" type="info" effect="plain">已归档</el-tag>
              <el-tag :type="page.statusMeta(row.status).type" effect="plain">
                {{ page.statusMeta(row.status).label }}
              </el-tag>
              <AppButton
                v-if="!row.archivedAt && page.canConsumeOrders && row.operations.canConsume"
                size="small"
                variant="primary"
                :loading="page.consumingOrderId === row.id"
                :disabled="page.isParameterTransition"
                @click="page.consumeOrderBalance(row)"
              >
                <el-icon><Coin /></el-icon>
                扣减
              </AppButton>
              <AppButton
                v-if="!row.archivedAt && page.canUpdateOrders && row.operations.canComplete"
                size="small"
                variant="primary"
                :loading="page.completingOrderId === row.id"
                :disabled="page.isParameterTransition"
                @click="page.completeOrder(row)"
              >
                <el-icon><CircleCheck /></el-icon>
                确认开通
              </AppButton>
            </div>
          </template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.orders.main.columns[16]">
          <template #default="{ row }">
            <V2OrderRowActions :order="row" :page="page" />
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.orders.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <el-checkbox
                v-if="
                  page.canUpdateOrders &&
                  (page.archive.canArchive(item) || page.archive.isSelected(item))
                "
                :model-value="page.archive.isSelected(item)"
                :disabled="page.isParameterTransition || page.archive.saving"
                :aria-label="`选择归档订单 ${item.orderNo}`"
                @change="page.archive.select(item, $event)"
                ><span class="visually-hidden">选择归档订单 {{ item.orderNo }}</span></el-checkbox
              >
              <strong v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'orderNo']">
                {{ item.orderNo }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.orders.main.id, '客户']">
                {{ item.customer.name }}
              </span>
              <span v-v2-column-visibility="[v2TableSchemas.orders.main.id, '分类']">
                {{ item.service.parent?.name || '未分类' }}
              </span>
              <span v-v2-column-visibility="[v2TableSchemas.orders.main.id, '业务']">
                {{ item.service.name }}
              </span>
            </div>
            <div class="v2-order-mobile-progress">
              <el-tag v-if="item.archivedAt" type="info" effect="plain">已归档</el-tag>
              <el-tag
                class="v2-status-tag"
                :type="page.statusMeta(item.status).type"
                effect="plain"
              >
                {{ page.statusMeta(item.status).label }}
              </el-tag>
              <AppButton
                v-if="!item.archivedAt && page.canConsumeOrders && item.operations.canConsume"
                size="small"
                variant="primary"
                :loading="page.consumingOrderId === item.id"
                :disabled="page.isParameterTransition"
                @click="page.consumeOrderBalance(item)"
              >
                <el-icon><Coin /></el-icon>
                扣减余额
              </AppButton>
              <AppButton
                v-if="!item.archivedAt && page.canUpdateOrders && item.operations.canComplete"
                size="small"
                variant="primary"
                :loading="page.completingOrderId === item.id"
                :disabled="page.isParameterTransition"
                @click="page.completeOrder(item)"
              >
                <el-icon><CircleCheck /></el-icon>
                确认开通
              </AppButton>
            </div>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, '分类']">
              <dt>业务分类</dt>
              <dd>{{ item.service.parent?.name || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, '充值苹果邮箱']">
              <dt>充值苹果邮箱</dt>
              <dd>
                {{ item.account?.displayAppleId || '—' }}
                <el-tag
                  v-if="item.accountSource === 'customer_owned'"
                  type="warning"
                  effect="plain"
                >
                  客户已购
                </el-tag>
              </dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, '客户业务账号']">
              <dt>客户业务账号</dt>
              <dd>{{ item.displayWebsiteAccount || '未填写' }}</dd>
            </div>
            <div v-if="item.sourceSoldOrder">
              <dt>原销售订单</dt>
              <dd>{{ item.sourceSoldOrder.orderNo }} · {{ item.sourceSoldOrder.customer.name }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'accountDisposition']">
              <dt>ID 处理状态</dt>
              <dd>{{ page.accountDispositionMeta(item.accountDisposition, item.status).label }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'accountCostAmount']">
              <dt>ID成本</dt>
              <dd>{{ page.formatDecimal(item.appliedAccountCostAmount) }}</dd>
            </div>
            <div>
              <dt>结算平台</dt>
              <dd>{{ item.settlementPlatform?.name || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'receivedAmount']">
              <dt>实收金额</dt>
              <dd>{{ page.formatDecimal(item.receivedAmount) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'profitAmount']">
              <dt>利润</dt>
              <dd :class="page.profitClass(item.profitAmount)">
                {{ page.formatNullableDecimal(item.profitAmount) }}
              </dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, '利润率']">
              <dt>利润率</dt>
              <dd :class="page.profitClass(item.profitRate)">
                {{ item.profitRate === null ? '—' : `${page.formatDecimal(item.profitRate)}%` }}
              </dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'createdAt']">
              <dt>订单时间</dt>
              <dd>{{ page.formatDate(item.createdAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, '操作人']">
              <dt>操作人</dt>
              <dd>{{ operatorUsername(item.createdBy) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'openedAt']">
              <dt>开通时间</dt>
              <dd>{{ page.formatDate(item.openedAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.orders.main.id, 'dueAt']">
              <dt>到期时间</dt>
              <dd>{{ page.formatDate(item.dueAt) }}</dd>
            </div>
          </dl>
          <footer>
            <div class="v2-order-row-actions">
              <V2OrderRowActions :order="item" :page="page" mobile />
            </div>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无订单</strong>
          <span>{{ page.hasActiveFilters ? '当前筛选条件下没有数据' : '系统中暂无订单' }}</span>
          <AppButton
            v-if="page.canConsumeOrders"
            size="small"
            variant="primary"
            @click="page.openOrderEntry"
          >
            录入新订单
          </AppButton>
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
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { CircleCheck, Coin } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { operatorUsername } from '@/v2/utils/operator';
import type { UnwrapNestedRefs } from 'vue';
import type { useOrdersPage } from '../useOrdersPage';
import V2OrderRowActions from './V2OrderRowActions.vue';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

const props = defineProps<{
  page: OrdersPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
