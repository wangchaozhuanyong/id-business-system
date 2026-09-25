<template>
  <section class="v2-records-page bank-recharge-page">
    <V2PageContext
      description="记录银行卡代充、客户手续费、银行手续费、实收与到期时间。官网成功付款自动建立待补全订单。"
    >
      <template #actions>
        <AppButton variant="ghost" @click="currencyOpen = true">新增币种</AppButton>
        <AppButton variant="ghost" @click="cardOpen = true">新增银行卡</AppButton>
        <AppButton variant="primary" @click="openCreate">手工录入银充</AppButton>
      </template>
    </V2PageContext>

    <section class="bank-recharge-toolbar" aria-label="银充订单筛选">
      <el-input
        v-model="keywordInput"
        clearable
        aria-label="搜索银充订单"
        placeholder="订单号、客户、账号或卡尾号"
        @keyup.enter="applyFilters"
        @clear="applyFilters"
      />
      <el-select v-model="statusInput" aria-label="银充订单状态">
        <el-option label="全部状态" value="" />
        <el-option label="待补全" value="pending_details" />
        <el-option label="已完成" value="completed" />
        <el-option label="已退款" value="refunded" />
      </el-select>
      <AppButton variant="soft" @click="applyFilters">查询</AppButton>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :phase="ordersQuery.phase.value"
      :previous-data="ordersQuery.isParameterTransition.value"
      :error="ordersQuery.error.value ? getApiErrorMessage(ordersQuery.error.value) : ''"
      loading-title="正在加载银充订单"
      @retry="ordersQuery.refresh"
    >
      <section class="v2-records-list">
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
          :view-key="`${page}:${pageSize}:${keyword}:${status}`"
          :data="data?.items ?? []"
          class="v2-records-table bank-recharge-nowrap"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无银充订单</strong>
              <span>{{
                keyword || status
                  ? '当前筛选条件下没有数据'
                  : '官网付款成功后会自动建立，或使用右上角手工录入'
              }}</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeOrders.main.columns[0]"
            prop="orderNo"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[1]"
            ><template #default="{ row }">{{
              formatV2DateTime(row.createdAt)
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[2]"
            ><template #default="{ row }">{{
              row.customer?.name ?? '待设客户'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[3]"
            ><template #default="{ row }">{{
              row.account?.emailMasked ?? '待关联账号'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[4]"
            ><template #default="{ row }">{{ planLabel(row.plan) }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[5]"
            ><template #default="{ row }">{{
              row.card
                ? `${row.card.label} ····${row.card.last4}`
                : row.cardLast4
                  ? `····${row.cardLast4}`
                  : '待设银行卡'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[6]"
            ><template #default="{ row }"
              >{{ row.chargeAmount }} {{ row.chargeCurrencyCode }}</template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[7]"
            ><template #default="{ row }">{{ row.customerFeeRate }}%</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[8]"
            ><template #default="{ row }"
              >{{ row.customerFeeAmount }} {{ row.chargeCurrencyCode }}</template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[9]"
            ><template #default="{ row }">{{
              row.bankFeeAmount ? `${row.bankFeeAmount} ${row.bankFeeCurrencyCode}` : '—'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[10]"
            ><template #default="{ row }">{{
              row.receivedAmount ? `${row.receivedAmount} ${row.receivedCurrencyCode}` : '待设'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[11]"
            ><template #default="{ row }">{{
              row.profitAmountCny ?? '待入账'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[12]"
            ><template #default="{ row }">{{
              row.dueAt ? formatV2DateTime(row.dueAt) : '待设'
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[13]"
            ><template #default="{ row }"
              ><el-tag :type="row.status === 'refunded' ? 'warning' : 'success'" effect="plain">{{
                row.status === 'refunded'
                  ? '已退款'
                  : row.source === 'automatic'
                    ? '官网已充值'
                    : '手工已录入'
              }}</el-tag></template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[14]"
            ><template #default="{ row }"
              ><el-tag :type="usageTagType(row)" effect="plain">{{
                usageLabel(row)
              }}</el-tag></template
            ></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[15]"
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
                >{{ statusLabel(row.status) }}</el-tag
              ></template
            ></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.bankRechargeOrders.main.columns[16]">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="openEdit(row)">{{
                row.status === 'completed' || row.status === 'refunded' ? '详情' : '修改'
              }}</AppButton>
              <AppButton
                v-if="row.status === 'pending_details'"
                size="small"
                variant="ghost"
                :disabled="working"
                @click="complete(row)"
                >完成</AppButton
              >
              <AppButton
                v-else-if="row.status === 'completed'"
                size="small"
                variant="ghost"
                :disabled="working"
                @click="openRefund(row)"
                >退款</AppButton
              >
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
  </section>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
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
import { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const drawerState = useBankRechargeOrdersPage();
const {
  page,
  pageSize,
  keywordInput,
  statusInput,
  keyword,
  status,
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
  complete,
  openRefund,
  applyFilters,
  changePage,
  changePageSize
} = drawerState;
</script>
