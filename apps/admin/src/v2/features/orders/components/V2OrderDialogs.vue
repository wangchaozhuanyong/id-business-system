<template>
  <el-drawer v-model="page.detailVisible" title="订单详情" size="min(680px, 94vw)">
    <V2AsyncRegion
      variant="section"
      skeleton="detail"
      :loading="page.detailLoading"
      :resolved="Boolean(page.detail)"
      :error="page.detailError"
      loading-title="正在加载订单详情"
      refreshing-title="正在更新订单详情"
      error-title="订单详情加载失败"
      @retry="page.retryDetail"
    >
      <div v-if="page.detail" class="v2-order-detail">
        <section>
          <h3>订单资料</h3>
          <dl>
            <div>
              <dt>订单号</dt>
              <dd>{{ page.detail.orderNo }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{{ page.statusMeta(page.detail.status).label }}</dd>
            </div>
            <div>
              <dt>客户</dt>
              <dd>{{ page.detail.customer.name }}</dd>
            </div>
            <div>
              <dt>业务</dt>
              <dd>{{ page.detail.service.name }}</dd>
            </div>
            <div>
              <dt>使用 ID</dt>
              <dd>{{ page.detail.account?.appleIdMasked || '-' }}</dd>
            </div>
            <div>
              <dt>国家</dt>
              <dd>{{ page.detail.account?.country.name || '-' }}</dd>
            </div>
            <div>
              <dt>网站账号</dt>
              <dd>{{ page.detail.maskedWebsiteAccount || '-' }}</dd>
            </div>
            <div>
              <dt>结算平台</dt>
              <dd>{{ page.detail.settlementPlatform?.name || '-' }}</dd>
            </div>
            <div>
              <dt>平台订单号</dt>
              <dd>{{ page.detail.platformOrderNo || '-' }}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>金额与成本</h3>
          <dl>
            <div>
              <dt>实收金额</dt>
              <dd>{{ page.formatDecimal(page.detail.receivedAmount) }}</dd>
            </div>
            <div>
              <dt>平台手续费</dt>
              <dd>{{ page.formatDecimal(page.detail.platformFeeAmount) }}</dd>
            </div>
            <div title="ID 购买成本快照，不在每笔订阅订单中重复计入利润">
              <dt>ID 成本快照</dt>
              <dd>{{ page.formatDecimal(page.detail.accountCostAmount) }}</dd>
            </div>
            <div>
              <dt>消耗余额</dt>
              <dd>{{ page.formatDecimal(page.detail.balanceAmount) }}</dd>
            </div>
            <div>
              <dt>余额成本</dt>
              <dd>{{ page.formatDecimal(page.detail.balanceCostAmount) }}</dd>
            </div>
            <div>
              <dt>退款成本</dt>
              <dd>{{ page.formatNullableDecimal(page.detail.refundCostAmount) }}</dd>
            </div>
            <div>
              <dt>利润</dt>
              <dd :class="page.profitClass(page.detail.profitAmount)">
                {{ page.formatNullableDecimal(page.detail.profitAmount) }}
              </dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>时间与备注</h3>
          <dl>
            <div>
              <dt>开通时间</dt>
              <dd>{{ page.formatDate(page.detail.openedAt) }}</dd>
            </div>
            <div>
              <dt>到期时间</dt>
              <dd>{{ page.formatDate(page.detail.dueAt) }}</dd>
            </div>
            <div>
              <dt>状态时间</dt>
              <dd>{{ page.formatDate(page.detail.statusChangedAt) }}</dd>
            </div>
            <div>
              <dt>订单时间</dt>
              <dd>{{ page.formatDate(page.detail.createdAt) }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ page.formatDate(page.detail.updatedAt) }}</dd>
            </div>
            <div>
              <dt>备注</dt>
              <dd>{{ page.detail.remark || '-' }}</dd>
            </div>
          </dl>
        </section>
        <section v-if="page.detail.activeLock">
          <h3>ID 锁定证据</h3>
          <dl>
            <div>
              <dt>锁定范围</dt>
              <dd>{{ page.lockScopeLabel(page.detail.activeLock.lockScope) }}</dd>
            </div>
            <div>
              <dt>锁定时间</dt>
              <dd>{{ page.formatDate(page.detail.activeLock.lockedAt) }}</dd>
            </div>
            <div>
              <dt>锁定到期</dt>
              <dd>{{ page.formatDate(page.detail.activeLock.expiresAt) }}</dd>
            </div>
            <div>
              <dt>锁定原因</dt>
              <dd>{{ page.detail.activeLock.reason || '-' }}</dd>
            </div>
          </dl>
        </section>
        <footer class="v2-order-detail-actions">
          <AppButton
            v-if="page.canConsumeOrders && page.detail.operations.canConsume"
            variant="primary"
            :loading="page.consumingOrderId === page.detail.id"
            @click="page.consumeOrderBalance(page.detail)"
          >
            <el-icon><Coin /></el-icon>
            扣减余额
          </AppButton>
          <AppButton
            v-if="page.canUpdateOrders && page.detail.operations.canComplete"
            variant="primary"
            :loading="page.completingOrderId === page.detail.id"
            @click="page.completeOrder(page.detail)"
          >
            <el-icon><CircleCheck /></el-icon>
            确认开通
          </AppButton>
          <AppButton
            v-if="page.canUpdateOrders && page.detail.operations.canEdit"
            variant="ghost"
            @click="page.openEdit(page.detail)"
          >
            <el-icon><Edit /></el-icon>
            修改
          </AppButton>
          <AppButton
            v-if="page.canUpdateOrders && page.detail.operations.canRefund"
            variant="ghost"
            @click="page.openRefund(page.detail)"
          >
            退款
          </AppButton>
          <AppButton
            v-if="page.canUpdateOrders && page.detail.operations.canCancel"
            variant="ghost"
            :loading="page.lifecycleBusyOrderId === page.detail.id"
            @click="page.cancelOrder(page.detail)"
          >
            取消订单
          </AppButton>
          <AppButton
            v-if="page.canDeleteOrders && page.detail.operations.canDelete"
            variant="danger"
            :loading="page.lifecycleBusyOrderId === page.detail.id"
            @click="page.deleteOrder(page.detail)"
          >
            删除记录
          </AppButton>
        </footer>
      </div>
    </V2AsyncRegion>
  </el-drawer>

  <V2OrderEditDrawer
    v-model="page.editVisible"
    :order="page.editingOrder"
    :saving="page.editSaving"
    @submit="page.updateOrder"
  />

  <V2OrderRefundDialog
    v-model="page.refundVisible"
    :order="page.refundingOrder"
    :saving="page.refundSaving"
    @submit="page.refundOrder"
  />
</template>

<script setup lang="ts">
import { CircleCheck, Coin, Edit } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2OrderEditDrawer from './V2OrderEditDrawer.vue';
import V2OrderRefundDialog from './V2OrderRefundDialog.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useOrdersPage } from '../useOrdersPage';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

defineProps<{
  page: OrdersPage;
}>();
</script>
