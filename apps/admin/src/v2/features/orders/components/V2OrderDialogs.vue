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
        <V2DetailSummary
          heading-id="order-detail-summary"
          eyebrow="订单对象"
          :title="page.detail.orderNo"
          :description="`${page.detail.customer.name} · ${page.detail.service.name}`"
          :metrics="[
            { label: '实收金额', value: page.formatDecimal(page.detail.receivedAmount) },
            {
              label: '预计利润',
              value: page.formatNullableDecimal(page.detail.profitAmount),
              tone: Number(page.detail.profitAmount ?? 0) < 0 ? 'negative' : 'positive'
            }
          ]"
          :facts="[
            { label: '订单状态', value: page.statusMeta(page.detail.status).label },
            { label: '使用 ID', value: page.detail.account?.displayAppleId || '—' },
            {
              label: 'ID 处理',
              value: page.accountDispositionMeta(page.detail.accountDisposition, page.detail.status)
                .label
            }
          ]"
        />
        <V2PanelSection heading-id="order-detail-business" title="业务与 ID" step="01">
          <dl class="v2-order-detail__facts">
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
              <dd>{{ page.detail.account?.displayAppleId || '—' }}</dd>
            </div>
            <div>
              <dt>ID 来源</dt>
              <dd>
                {{ page.detail.accountSource === 'customer_owned' ? '客户已购 ID' : '库存 ID' }}
              </dd>
            </div>
            <div v-if="page.detail.sourceSoldOrder">
              <dt>原销售订单</dt>
              <dd>
                {{ page.detail.sourceSoldOrder.orderNo }} ·
                {{ page.detail.sourceSoldOrder.customer.name }}
              </dd>
            </div>
            <div>
              <dt>ID 处理状态</dt>
              <dd>
                {{
                  page.accountDispositionMeta(page.detail.accountDisposition, page.detail.status)
                    .label
                }}
              </dd>
            </div>
            <div>
              <dt>国家</dt>
              <dd>{{ page.detail.account?.country.name || '—' }}</dd>
            </div>
            <div>
              <dt>网站账号</dt>
              <dd>{{ page.detail.displayWebsiteAccount || '—' }}</dd>
            </div>
            <div>
              <dt>结算平台</dt>
              <dd>{{ page.detail.settlementPlatform?.name || '—' }}</dd>
            </div>
            <div>
              <dt>平台订单号</dt>
              <dd>{{ page.detail.platformOrderNo || '—' }}</dd>
            </div>
          </dl>
        </V2PanelSection>
        <V2PanelSection heading-id="order-detail-finance" title="金额与成本" step="02">
          <dl class="v2-order-detail__facts">
            <div>
              <dt>实收金额</dt>
              <dd>{{ page.formatDecimal(page.detail.receivedAmount) }}</dd>
            </div>
            <div>
              <dt>平台手续费</dt>
              <dd>{{ page.formatDecimal(page.detail.platformFeeAmount) }}</dd>
            </div>
            <div title="选择卖出 ID 时保存的购买成本快照，后续修改 ID 资料不会改写">
              <dt>ID 购买成本快照</dt>
              <dd>{{ page.formatDecimal(page.detail.accountCostAmount) }}</dd>
            </div>
            <div>
              <dt>本单计入 ID 成本</dt>
              <dd>{{ page.formatDecimal(page.detail.appliedAccountCostAmount) }}</dd>
            </div>
            <div>
              <dt>消耗余额</dt>
              <dd>{{ page.formatDecimal(page.detail.balanceAmount) }}</dd>
            </div>
            <div>
              <dt>余额成本（人民币）</dt>
              <dd>{{ page.formatDecimal(page.detail.balanceCostAmount) }}</dd>
            </div>
            <div>
              <dt>额外退款成本（人民币）</dt>
              <dd>{{ page.formatNullableDecimal(page.detail.refundCostAmount) }}</dd>
            </div>
            <div>
              <dt>利润</dt>
              <dd :class="page.profitClass(page.detail.profitAmount)">
                {{ page.formatNullableDecimal(page.detail.profitAmount) }}
              </dd>
            </div>
            <div>
              <dt>实际利润率</dt>
              <dd :class="page.profitClass(page.detail.profitRate)">
                {{
                  page.detail.profitRate === null
                    ? '—'
                    : `${page.formatDecimal(page.detail.profitRate)}%`
                }}
              </dd>
            </div>
          </dl>
        </V2PanelSection>
        <V2PanelSection
          v-if="page.detail.upgradeBalanceReturn"
          heading-id="order-detail-upgrade-balance-return"
          title="升级退币记录"
          step="03"
        >
          <dl class="v2-order-detail__facts">
            <div>
              <dt>记录状态</dt>
              <dd>
                {{ page.detail.upgradeBalanceReturn.status === 'active' ? '已生效' : '已撤销' }}
              </dd>
            </div>
            <div>
              <dt>实际退回余额</dt>
              <dd>
                {{ page.formatDecimal(page.detail.upgradeBalanceReturn.returnedBalanceAmount) }}
                {{ page.detail.upgradeBalanceReturn.currencyCode }}
              </dd>
            </div>
            <div>
              <dt>恢复余额成本</dt>
              <dd>
                ¥{{
                  page.formatDecimal(page.detail.upgradeBalanceReturn.restoredBalanceCostAmount)
                }}
              </dd>
            </div>
            <div>
              <dt>登记前利润</dt>
              <dd>
                ¥{{ page.formatDecimal(page.detail.upgradeBalanceReturn.originalProfitAmount) }}
              </dd>
            </div>
            <div>
              <dt>登记后利润</dt>
              <dd>
                ¥{{ page.formatDecimal(page.detail.upgradeBalanceReturn.adjustedProfitAmount) }}
              </dd>
            </div>
            <div>
              <dt>登记时间</dt>
              <dd>{{ page.formatDate(page.detail.upgradeBalanceReturn.createdAt) }}</dd>
            </div>
            <div>
              <dt>登记原因</dt>
              <dd>{{ page.detail.upgradeBalanceReturn.reason }}</dd>
            </div>
            <div v-if="page.detail.upgradeBalanceReturn.reversedAt">
              <dt>撤销时间</dt>
              <dd>{{ page.formatDate(page.detail.upgradeBalanceReturn.reversedAt) }}</dd>
            </div>
            <div v-if="page.detail.upgradeBalanceReturn.reversalReason">
              <dt>撤销原因</dt>
              <dd>{{ page.detail.upgradeBalanceReturn.reversalReason }}</dd>
            </div>
          </dl>
        </V2PanelSection>
        <V2PanelSection heading-id="order-detail-timeline" title="时间与备注" step="04">
          <dl class="v2-order-detail__facts">
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
              <dd>{{ page.detail.remark || '—' }}</dd>
            </div>
          </dl>
        </V2PanelSection>
        <V2PanelSection
          v-if="page.detail.activeLock"
          heading-id="order-detail-lock"
          title="ID 锁定证据"
          step="05"
        >
          <dl class="v2-order-detail__facts">
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
              <dd>{{ page.detail.activeLock.reason || '—' }}</dd>
            </div>
          </dl>
        </V2PanelSection>
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
            v-if="page.canUpdateOrders && page.detail.operations.canRecordUpgradeBalanceReturn"
            variant="ghost"
            @click="page.openUpgradeBalanceReturn(page.detail)"
          >
            登记升级退币
          </AppButton>
          <AppButton
            v-if="page.canUpdateOrders && page.detail.operations.canReverseUpgradeBalanceReturn"
            variant="ghost"
            :loading="page.lifecycleBusyOrderId === page.detail.id"
            @click="page.reverseUpgradeBalanceReturn(page.detail)"
          >
            撤销升级退币
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

  <V2OrderUpgradeBalanceReturnDialog
    v-model="page.upgradeBalanceReturnVisible"
    :order="page.upgradeBalanceReturnOrder"
    :saving="page.upgradeBalanceReturnSaving"
    @submit="page.recordUpgradeBalanceReturn"
  />
</template>

<script setup lang="ts">
import { CircleCheck, Coin, Edit } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import V2OrderEditDrawer from './V2OrderEditDrawer.vue';
import V2OrderRefundDialog from './V2OrderRefundDialog.vue';
import V2OrderUpgradeBalanceReturnDialog from './V2OrderUpgradeBalanceReturnDialog.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useOrdersPage } from '../useOrdersPage';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

defineProps<{
  page: OrdersPage;
}>();
</script>
