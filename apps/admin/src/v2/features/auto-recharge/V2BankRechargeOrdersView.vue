<template>
  <section class="v2-page-layout v2-records-page bank-recharge-page">
    <V2PageContext
      description="记录比特浏览器充值的当次官网实付、出口国家、手续费、客户实收与到期时间。升级只记录本次补付金额。"
    >
      <template #actions>
        <BitOrderPricingSettings :state="pricing" />
        <AppButton variant="ghost" @click="currencyOpen = true">新增币种</AppButton>
        <AppButton variant="ghost" @click="cardOpen = true">新增银行卡</AppButton>
        <AppButton variant="primary" @click="openCreate">手工录入比特充值</AppButton>
      </template>
    </V2PageContext>

    <el-tabs v-model="deletedFilter" aria-label="比特充值记录范围"
      ><el-tab-pane label="业务清单" name="active" /><el-tab-pane label="回收站" name="deleted"
    /></el-tabs>
    <el-tabs v-model="expiry" aria-label="比特订单分类">
      <el-tab-pane label="全部订单" name="all" />
      <el-tab-pane label="已到期订单" name="expired" />
    </el-tabs>

    <section class="bank-recharge-toolbar" aria-label="比特订单筛选">
      <el-select v-model="executionSource" aria-label="充值订单来源">
        <el-option label="比特浏览器订单" value="bitbrowser" />
        <el-option label="全部来源（含手工历史）" value="" />
      </el-select>
      <el-input
        v-model="keywordInput"
        clearable
        aria-label="搜索比特订单"
        placeholder="订单号、客户、账号或卡尾号"
        @keyup.enter="applyFilters"
        @clear="applyFilters"
      />
      <el-select v-model="statusInput" aria-label="比特订单状态">
        <el-option label="全部状态" value="" />
        <el-option label="待补全" value="pending_details" />
        <el-option label="已完成" value="completed" />
        <el-option label="已退款" value="refunded" />
        <el-option label="已作废" value="cancelled" />
      </el-select>
      <AppButton variant="soft" @click="applyFilters">查询</AppButton>
    </section>
    <p v-if="accountIdFilter" class="bank-recharge-form-note">
      正在查看所选 ChatGPT 账号的订单。
      <AppButton size="small" variant="ghost" @click="clearAccountFilter">查看全部订单</AppButton>
    </p>

    <p v-if="restoreNavigationError" class="bank-recharge-error" role="alert">
      {{ restoreNavigationError }}
    </p>
    <p
      v-if="pricing.query.error.value || pricing.ratesQuery.error.value"
      class="bank-recharge-error"
      role="alert"
    >
      收费设置或汇率缓存加载失败，未核实的金额与利润暂不计算。
      <AppButton size="small" variant="ghost" @click="retryPricing">重新加载</AppButton>
    </p>
    <V2AsyncRegion
      skeleton="table"
      :phase="ordersQuery.phase.value"
      :previous-data="ordersQuery.isParameterTransition.value"
      :error="ordersQuery.error.value ? getApiErrorMessage(ordersQuery.error.value) : ''"
      loading-title="正在加载比特订单"
      @retry="ordersQuery.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="订单清单">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.bankRechargeOrders.main" />
              <span>共 {{ data?.total ?? 0 }} 条</span>
            </template>
          </V2SectionHeading>
        </header>
        <V2Table
          :schema="v2TableSchemas.bankRechargeOrders.main"
          :show-column-settings="false"
          :view-key="`${executionSource}:${page}:${pageSize}:${keyword}:${status}:${expiry}`"
          :data="data?.items ?? []"
          class="v2-records-table bank-recharge-nowrap"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>{{ expiry === 'expired' ? '暂无已到期订单' : '暂无比特订单' }}</strong>
              <span>{{
                expiry === 'expired' || keyword || status
                  ? '当前筛选条件下没有数据'
                  : '官网付款成功后会自动建立，或使用右上角手工录入'
              }}</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeOrders.main.columns[0]"
            show-overflow-tooltip
            ><template #default="{ row }"
              >{{ row.orderNo
              }}<el-tag
                v-if="row.accountingVersion !== 'subscription_cost_v2'"
                type="info"
                size="small"
                >旧口径</el-tag
              ></template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[1]"
            ><template #default="{ row }">{{
              row.customer?.name ?? '待设客户'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[2]"
            ><template #default="{ row }">{{
              row.account?.emailMasked ?? '待关联账号'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[3]"
            ><template #default="{ row }">{{ planLabel(row.plan) }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[4]"
            ><template #default="{ row }">{{
              row.card
                ? `${row.card.label} ····${row.card.last4}`
                : row.cardLast4
                  ? `····${row.cardLast4}`
                  : '待设银行卡'
            }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeOrders.main.columns[5]"
            show-overflow-tooltip
            ><template #default="{ row }"
              >{{ row.chargeAmount }} {{ row.chargeCurrencyCode }} ·
              {{
                row.chargeCountryCode ? chatgptCountryLabel(row.chargeCountryCode) : '国家待核实'
              }}</template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[6]"
            ><template #default="{ row }">{{ feeLabel(row, 'usdtFee') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[7]"
            ><template #default="{ row }">{{
              feeLabel(row, 'shoppingFee')
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[8]"
            ><template #default="{ row }">{{ receiptLabel(row) }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[9]"
            ><template #default="{ row }">{{ profitLabel(row) }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[10]"
            ><template #default="{ row }">{{
              row.openedAt ? formatV2DateTime(row.openedAt) : '日期待核对'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[11]"
            ><template #default="{ row }">{{
              row.dueAt ? formatV2DateTime(row.dueAt) : '日期待核对'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[12]"
            ><template #default="{ row }"
              ><el-tag :type="row.status === 'refunded' ? 'warning' : 'success'" effect="plain">{{
                row.status === 'cancelled'
                  ? '已作废'
                  : row.status === 'refunded'
                    ? '已退款'
                    : row.source === 'automatic'
                      ? '官网已充值'
                      : '手工已录入'
              }}</el-tag></template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[13]">
            <template #header>
              <span class="v2-records-help-title">
                {{ v2TableSchemas.bankRechargeOrders.main.columns[13].label }}
                <FeatureHelp
                  title="使用状态说明"
                  :text="usageStatusHelp"
                  placement="bottom"
                  :width="360"
                />
              </span>
            </template>
            <template #default="{ row }">
              <el-tag :type="usageTagType(row)" effect="plain">{{ usageLabel(row) }}</el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[14]"
            ><template #default="{ row }"
              ><el-tag
                :type="
                  row.status === 'completed'
                    ? 'success'
                    : row.status === 'refunded'
                      ? 'warning'
                      : 'info'
                "
                effect="plain"
                >{{ statusLabel(row.status, row.financeStatus) }}</el-tag
              ></template
            ></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[15]">
            <template #default="{ row }">
              <AppButton
                v-if="row.deletedAt"
                size="small"
                variant="ghost"
                @click="requestRestore('bank_recharge_order', row, row.orderNo)"
                >申请恢复</AppButton
              >
              <template v-else>
                <AppButton size="small" variant="ghost" @click="openEdit(row)">{{
                  ['completed', 'refunded', 'cancelled'].includes(row.status) ? '详情' : '修改'
                }}</AppButton>
                <AppButton
                  v-if="row.status === 'pending_details'"
                  size="small"
                  variant="ghost"
                  :disabled="working"
                  @click="complete(row)"
                  >完成</AppButton
                >
                <el-dropdown trigger="click">
                  <AppButton size="small" variant="ghost" :disabled="working">更多操作</AppButton>
                  <template #dropdown
                    ><el-dropdown-menu>
                      <el-dropdown-item
                        v-if="row.status === 'completed' && row.financeStatus === 'posted'"
                        @click="openCorrection(row)"
                        >更正订单</el-dropdown-item
                      >
                      <el-dropdown-item
                        v-if="
                          row.status === 'completed' ||
                          (row.status === 'refunded' && row.financeStatus === 'partial')
                        "
                        @click="openRefund(row)"
                        >退款与回款</el-dropdown-item
                      >
                      <el-dropdown-item
                        v-if="row.accountId && !['cancelled', 'refunded'].includes(row.status)"
                        @click="reviewOrderId = row.id"
                        >核对订阅</el-dropdown-item
                      >
                      <el-dropdown-item
                        v-if="
                          row.source === 'manual' &&
                          row.financeStatus === 'unposted' &&
                          row.status !== 'cancelled'
                        "
                        @click="lifecycleTarget = { entity: 'order', id: row.id, action: 'cancel' }"
                        >作废误录</el-dropdown-item
                      >
                      <el-dropdown-item
                        v-if="row.status === 'cancelled'"
                        @click="
                          lifecycleTarget = { entity: 'order', id: row.id, action: 'restore' }
                        "
                        >恢复待补全</el-dropdown-item
                      >
                      <el-dropdown-item
                        v-if="row.status === 'cancelled'"
                        @click="lifecycleTarget = { entity: 'order', id: row.id, action: 'delete' }"
                        >移入回收站</el-dropdown-item
                      >
                    </el-dropdown-menu></template
                  >
                </el-dropdown>
              </template>
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ data?.total ?? 0 }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="page"
            :page-size="pageSize"
            :page-sizes="[20, 50, 100]"
            :total="data?.total ?? 0"
            background
            layout="sizes, prev, pager, next"
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2BankRechargeOrderDrawers :state="drawerState" />
    <BankRechargeLifecycleDialog
      :target="lifecycleTarget"
      @close="lifecycleTarget = null"
      @completed="ordersQuery.refresh"
    />
    <BankRechargeSubscriptionReviewDialog
      :order-id="reviewOrderId"
      @close="reviewOrderId = null"
      @completed="ordersQuery.refresh"
    />
  </section>
</template>

<script setup lang="ts">
import { useBankRechargeRestoreNavigation } from './useBankRechargeRestoreNavigation';
const { requestRestore, restoreNavigationError } = useBankRechargeRestoreNavigation();
import { ref } from 'vue';
import BankRechargeLifecycleDialog from './BankRechargeLifecycleDialog.vue';
import BankRechargeSubscriptionReviewDialog from './BankRechargeSubscriptionReviewDialog.vue';
import type { BankLifecycleEntity, BankLifecycleAction } from './bank-recharge-api';
const lifecycleTarget = ref<{
  entity: BankLifecycleEntity;
  id: string;
  action: BankLifecycleAction;
} | null>(null);
const reviewOrderId = ref<string | null>(null);
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2BankRechargeOrderDrawers from './V2BankRechargeOrderDrawers.vue';
import BitOrderPricingSettings from './BitOrderPricingSettings.vue';
import { chatgptCountryLabel } from './chatgpt-country';
import type { BankRechargeOrder } from './bank-recharge-api';
import { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const usageStatusHelp = [
  '使用状态根据本单关联账号、已核对的开通与到期时间、当前订阅记录和服务器时间判断，不代表浏览器的登录状态。',
  '账号归属待核验：官网自动充值记录尚未关联核验通过的账号。',
  '开通时间待核对：官网自动充值记录的开通时间或到期时间尚未核对。',
  '时间同步中：服务器时间尚未同步，暂不判断是否到期。',
  '已到期：本单到期时间已达到或早于服务器当前时间。',
  '非当前使用：本单已关联账号，但对应订阅记录并非当前有效订阅。',
  '待关联账号：手工订单尚未关联账号，也没有当前有效订阅记录。',
  '使用中：对应订阅记录处于有效状态，且没有判定为已到期。'
];

function feeLabel(row: BankRechargeOrder, prefix: 'usdtFee' | 'shoppingFee') {
  const estimate = pricing.estimate(row);
  const amount = prefix === 'usdtFee' ? estimate.usdtFee : estimate.shoppingFee;
  const currency = prefix === 'usdtFee' ? estimate.usdtCurrency : estimate.shoppingCurrency;
  return row.accountingVersion !== 'subscription_cost_v2'
    ? '旧口径 / 未核对'
    : row[`${prefix}Amount`] == null
      ? amount === null
        ? '未核对'
        : `${amount} ${currency}（预估）`
      : `${row[`${prefix}Amount`]} ${row[`${prefix}CurrencyCode`] ?? ''}`;
}
function receiptLabel(row: BankRechargeOrder) {
  const preview = pricing.estimate(row);
  return preview.receipt === null
    ? '待设'
    : `${preview.receipt} ${preview.currency}${preview.receiptEstimated ? '（待核收）' : ''}`;
}
function profitLabel(row: BankRechargeOrder) {
  const preview = pricing.estimate(row);
  return preview.profit === null
    ? '待核对金额或汇率'
    : `${preview.profit}${preview.profitEstimated ? '（预估）' : ''}`;
}
function retryPricing() {
  void pricing.query.refresh();
  void pricing.ratesQuery.refresh();
}
const drawerState = useBankRechargeOrdersPage();
const {
  pricing,
  executionSource,
  expiry,
  deletedFilter,
  page,
  pageSize,
  keywordInput,
  statusInput,
  keyword,
  status,
  accountIdFilter,
  clearAccountFilter,
  currencyOpen,
  cardOpen,
  openCreate,
  ordersQuery,
  data,
  planLabel,
  usageLabel,
  usageTagType,
  statusLabel,
  working,
  openEdit,
  openCorrection,
  complete,
  openRefund,
  applyFilters,
  changePage,
  changePageSize
} = drawerState;
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => data.value?.items ?? [],
  pageSize: () => pageSize.value
});
</script>
