<template>
  <V2AsyncRegion
    skeleton="table"
    :loading="page.loading || page.isInitialLoading"
    :resolved="page.hasLoadedOnce"
    :error="page.listError"
    loading-title="正在加载订单"
    refreshing-title="正在更新订单"
    error-title="订单加载失败"
    @retry="page.loadOrders"
  >
    <section class="v2-records-list">
      <el-table
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        row-key="id"
        :default-sort="{ prop: 'openedAt', order: 'descending' }"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无订单</strong>
            <span>当前筛选条件下没有数据</span>
          </div>
        </template>

        <el-table-column prop="orderNo" label="订单" min-width="182" fixed="left" sortable="custom">
          <template #default="{ row }">
            <strong class="v2-order-number v2-table-cell">{{ row.orderNo }}</strong>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" min-width="165" sortable="custom">
          <template #default="{ row }">{{ page.formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="客户" min-width="140">
          <template #default="{ row }">
            <strong class="v2-table-cell">{{ row.customer.name }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="业务" min-width="150">
          <template #default="{ row }">{{ row.service.name }}</template>
        </el-table-column>
        <el-table-column label="使用 ID" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">
            <strong class="v2-table-cell">{{ row.account?.appleIdMasked || '-' }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="客户网站账号" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">{{ row.maskedWebsiteAccount || '-' }}</template>
        </el-table-column>
        <el-table-column prop="receivedAmount" label="实收金额" min-width="120" sortable="custom">
          <template #default="{ row }">¥{{ page.formatDecimal(row.receivedAmount) }}</template>
        </el-table-column>
        <el-table-column prop="profitAmount" label="利润" min-width="115" sortable="custom">
          <template #default="{ row }">
            <strong :class="page.profitClass(row.profitAmount)">
              ¥{{ page.formatNullableDecimal(row.profitAmount) }}
            </strong>
          </template>
        </el-table-column>
        <el-table-column prop="openedAt" label="开通时间" min-width="165" sortable="custom">
          <template #default="{ row }">{{ page.formatDate(row.openedAt) }}</template>
        </el-table-column>
        <el-table-column prop="dueAt" label="到期时间" min-width="165" sortable="custom">
          <template #default="{ row }">{{ page.formatDate(row.dueAt) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="108" sortable="custom">
          <template #default="{ row }">
            <el-tag :type="page.statusMeta(row.status).type" effect="plain">
              {{ page.statusMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="212" fixed="right">
          <template #default="{ row }">
            <div class="v2-order-row-actions">
              <AppButton
                v-if="page.canConsumeOrders && row.operations.canConsume"
                size="small"
                variant="primary"
                :loading="page.consumingOrderId === row.id"
                @click="page.consumeOrderBalance(row)"
              >
                <el-icon><Coin /></el-icon>
                扣减
              </AppButton>
              <AppButton
                v-if="page.canUpdateOrders && row.operations.canComplete"
                size="small"
                variant="primary"
                :loading="page.completingOrderId === row.id"
                @click="page.completeOrder(row)"
              >
                <el-icon><CircleCheck /></el-icon>
                确认开通
              </AppButton>
              <AppButton size="small" variant="ghost" @click="page.openDetail(row)">
                <el-icon><View /></el-icon>
                详情
              </AppButton>
              <AppButton
                v-if="page.canUpdateOrders && row.operations.canEdit"
                size="small"
                variant="ghost"
                icon-only
                title="修改订单"
                @click="page.openEdit(row)"
              >
                <el-icon><Edit /></el-icon>
              </AppButton>
              <el-dropdown
                v-if="page.hasLifecycleActions(row)"
                trigger="click"
                @command="page.handleLifecycleCommand($event, row)"
              >
                <AppButton
                  size="small"
                  variant="ghost"
                  icon-only
                  title="更多订单操作"
                  :loading="page.lifecycleBusyOrderId === row.id"
                >
                  <el-icon><MoreFilled /></el-icon>
                </AppButton>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-if="page.canUpdateOrders && row.operations.canRefund"
                      command="refund"
                    >
                      退款
                    </el-dropdown-item>
                    <el-dropdown-item
                      v-if="page.canUpdateOrders && row.operations.canCancel"
                      command="cancel"
                    >
                      取消订单
                    </el-dropdown-item>
                    <el-dropdown-item
                      v-if="page.canDeleteOrders && row.operations.canDelete"
                      command="delete"
                      divided
                      class="v2-order-action-danger"
                    >
                      删除记录
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="v2-records-mobile-list">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong>{{ item.orderNo }}</strong>
              <span>{{ item.customer.name }} / {{ item.service.name }}</span>
            </div>
            <el-tag :type="page.statusMeta(item.status).type" effect="plain">
              {{ page.statusMeta(item.status).label }}
            </el-tag>
          </header>
          <dl>
            <div>
              <dt>使用 ID</dt>
              <dd>{{ item.account?.appleIdMasked || '-' }}</dd>
            </div>
            <div>
              <dt>结算平台</dt>
              <dd>{{ item.settlementPlatform?.name || '-' }}</dd>
            </div>
            <div>
              <dt>实收金额</dt>
              <dd>{{ page.formatDecimal(item.receivedAmount) }}</dd>
            </div>
            <div>
              <dt>利润</dt>
              <dd :class="page.profitClass(item.profitAmount)">
                {{ page.formatNullableDecimal(item.profitAmount) }}
              </dd>
            </div>
            <div>
              <dt>订单时间</dt>
              <dd>{{ page.formatDate(item.createdAt) }}</dd>
            </div>
            <div>
              <dt>开通时间</dt>
              <dd>{{ page.formatDate(item.openedAt) }}</dd>
            </div>
            <div>
              <dt>到期时间</dt>
              <dd>{{ page.formatDate(item.dueAt) }}</dd>
            </div>
          </dl>
          <footer>
            <span>{{ item.maskedWebsiteAccount || '未填写网站账号' }}</span>
            <div class="v2-order-row-actions">
              <AppButton
                v-if="page.canConsumeOrders && item.operations.canConsume"
                size="small"
                variant="primary"
                :loading="page.consumingOrderId === item.id"
                @click="page.consumeOrderBalance(item)"
              >
                <el-icon><Coin /></el-icon>
                扣减余额
              </AppButton>
              <AppButton
                v-if="page.canUpdateOrders && item.operations.canComplete"
                size="small"
                variant="primary"
                :loading="page.completingOrderId === item.id"
                @click="page.completeOrder(item)"
              >
                <el-icon><CircleCheck /></el-icon>
                确认开通
              </AppButton>
              <AppButton size="small" variant="ghost" @click="page.openDetail(item)"
                >查看详情</AppButton
              >
              <AppButton
                v-if="page.canUpdateOrders && item.operations.canEdit"
                size="small"
                variant="ghost"
                @click="page.openEdit(item)"
              >
                修改
              </AppButton>
              <el-dropdown
                v-if="page.hasLifecycleActions(item)"
                trigger="click"
                @command="page.handleLifecycleCommand($event, item)"
              >
                <AppButton
                  size="small"
                  variant="soft"
                  :loading="page.lifecycleBusyOrderId === item.id"
                >
                  更多
                </AppButton>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-if="page.canUpdateOrders && item.operations.canRefund"
                      command="refund"
                    >
                      退款
                    </el-dropdown-item>
                    <el-dropdown-item
                      v-if="page.canUpdateOrders && item.operations.canCancel"
                      command="cancel"
                    >
                      取消订单
                    </el-dropdown-item>
                    <el-dropdown-item
                      v-if="page.canDeleteOrders && item.operations.canDelete"
                      command="delete"
                      divided
                      class="v2-order-action-danger"
                    >
                      删除记录
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无订单</strong>
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
</template>

<script setup lang="ts">
import { CircleCheck, Coin, Edit, MoreFilled, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useOrdersPage } from '../useOrdersPage';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

defineProps<{
  page: OrdersPage;
}>();
</script>
