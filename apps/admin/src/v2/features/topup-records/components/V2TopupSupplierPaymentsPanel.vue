<template>
  <section class="v2-supplier-payments-panel">
    <header class="v2-supplier-payment-summary" aria-label="有效付款汇总">
      <article>
        <span>有效到账 USDT</span>
        <strong>{{ formatDecimal(summary.activeReceivedUsdt) }} USDT</strong>
      </article>
      <article>
        <span>有效折算人民币</span>
        <strong>¥{{ formatDecimal(summary.activeCreditedCny) }}</strong>
      </article>
      <article>
        <span>加权平均汇率</span>
        <strong>
          {{
            summary.weightedAverageRate === null
              ? '—'
              : `¥${formatRate(summary.weightedAverageRate)}`
          }}
        </strong>
      </article>
      <article>
        <span>已记录网络手续费</span>
        <strong>{{ formatDecimal(summary.activeNetworkFeeUsdt) }} USDT</strong>
      </article>
    </header>

    <section class="v2-supplier-payments-toolbar" aria-label="付款记录筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="交易哈希、网络、备注、供应商"
        aria-label="搜索付款记录"
        @keyup.enter="applyFilters"
        @clear="applyFilters"
      />
      <el-select
        v-model="query.supplierOptionId"
        clearable
        placeholder="全部供应商"
        aria-label="筛选付款供应商"
        @change="applyFilters"
      >
        <el-option
          v-for="supplier in suppliers"
          :key="supplier.id"
          :label="supplier.name"
          :value="supplier.id"
        />
      </el-select>
      <el-select
        v-model="query.status"
        clearable
        placeholder="全部状态"
        aria-label="筛选付款状态"
        @change="applyFilters"
      >
        <el-option label="有效" value="active" />
        <el-option label="已撤销" value="reversed" />
      </el-select>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="付款开始日期"
        end-placeholder="付款结束日期"
        range-separator="至"
        aria-label="筛选实际付款日期"
        @change="applyFilters"
      />
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="应用筛选" @click="applyFilters">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新付款记录" :disabled="loading" @click="refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :phase="queryPhase"
      :previous-data="isParameterTransition"
      :error="error"
      loading-title="正在加载付款记录"
      refreshing-title="正在更新付款记录"
      error-title="付款记录加载失败"
      @retry="refresh"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.topupRecords.supplierPayments"
          class="v2-records-table"
          :data="items"
          scrollbar-always-on
          show-overflow-tooltip
          @sort-change="handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无付款记录</strong>
              <span>可从“加卡供应商”标签记录供应商付款</span>
            </div>
          </template>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[0]">
            <template #default="{ row }">
              <strong>{{ row.supplierNameSnapshot }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[1]"
            prop="receivedUsdt"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDecimal(row.receivedUsdt) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[2]">
            <template #default="{ row }">{{ formatDecimal(row.networkFeeUsdt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[3]"
            prop="settlementRateCnyUsdt"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ formatRate(row.settlementRateCnyUsdt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[4]"
            prop="creditedCny"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ formatDecimal(row.creditedCny) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[5]">
            <template #default="{ row }">
              <span v-if="row.balanceBeforeCny !== null && row.balanceAfterCny !== null">
                ¥{{ formatDecimal(row.balanceBeforeCny) }} → ¥{{
                  formatDecimal(row.balanceAfterCny)
                }}
              </span>
              <span v-else>—</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[6]">
            <template #default="{ row }">
              <div class="v2-payment-chain">
                <span>{{ row.network || '—' }}</span>
                <code>{{ row.transactionHash || '未记录交易哈希' }}</code>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[7]"
            prop="paidAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.paidAt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[8]"
            prop="createdAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.postedAt) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[9]">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
                {{ row.status === 'active' ? '有效' : '已撤销' }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[10]">
            <template #default="{ row }">{{ row.remark || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierPayments.columns[11]">
            <template #default="{ row }">
              {{ operatorUsername(row.operator, 'system') }}
            </template>
          </V2TableColumn>
          <V2TableActionColumn
            :definition="v2TableSchemas.topupRecords.supplierPayments.columns[12]"
          >
            <template #default="{ row }">
              <AppButton
                v-if="canManage && row.status === 'active'"
                size="small"
                variant="danger"
                @click="openReversal(row)"
              >
                撤销付款
              </AppButton>
              <span v-else>—</span>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div
          class="v2-records-mobile-list"
          :data-mobile-for="v2TableSchemas.topupRecords.supplierPayments.id"
        >
          <article v-for="item in items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong
                  v-v2-column-visibility="[
                    v2TableSchemas.topupRecords.supplierPayments.id,
                    '供应商'
                  ]"
                >
                  {{ item.supplierNameSnapshot }}
                </strong>
                <span
                  v-v2-column-visibility="[
                    v2TableSchemas.topupRecords.supplierPayments.id,
                    'paidAt'
                  ]"
                >
                  {{ formatDate(item.paidAt) }}
                </span>
              </div>
              <el-tag
                v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierPayments.id, '状态']"
                :type="item.status === 'active' ? 'success' : 'info'"
                effect="plain"
              >
                {{ item.status === 'active' ? '有效' : '已撤销' }}
              </el-tag>
            </header>
            <dl>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  'receivedUsdt'
                ]"
              >
                <dt>到账 USDT</dt>
                <dd>{{ formatDecimal(item.receivedUsdt) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  'settlementRateCnyUsdt'
                ]"
              >
                <dt>结算汇率</dt>
                <dd>¥{{ formatRate(item.settlementRateCnyUsdt) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  'creditedCny'
                ]"
              >
                <dt>折算人民币</dt>
                <dd>¥{{ formatDecimal(item.creditedCny) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  '手续费 USDT'
                ]"
              >
                <dt>网络手续费</dt>
                <dd>{{ formatDecimal(item.networkFeeUsdt) }} USDT</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  '供应商余额快照'
                ]"
              >
                <dt>余额快照</dt>
                <dd>
                  {{
                    item.balanceBeforeCny === null || item.balanceAfterCny === null
                      ? '—'
                      : `¥${formatDecimal(item.balanceBeforeCny)} → ¥${formatDecimal(
                          item.balanceAfterCny
                        )}`
                  }}
                </dd>
              </div>
            </dl>
            <footer>
              <span
                v-v2-column-visibility="[
                  v2TableSchemas.topupRecords.supplierPayments.id,
                  '网络和交易哈希'
                ]"
              >
                {{ item.network || '未记录网络' }}
              </span>
              <AppButton
                v-if="canManage && item.status === 'active'"
                size="small"
                variant="danger"
                @click="openReversal(item)"
              >
                撤销付款
              </AppButton>
            </footer>
          </article>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ total }} 条付款记录</span>
          <el-pagination
            v-pagination-label
            :current-page="displayedPage"
            :page-size="displayedPageSize"
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="total"
            :disabled="queryPhase === 'transitioning'"
            @current-change="handlePageChange"
            @size-change="handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2ConfirmDialog
      v-model="reversalVisible"
      title="撤销供应商付款"
      message="撤销会生成反向流水，不删除原付款记录；撤销后供应商余额允许变为负数。"
      confirm-text="确认撤销付款"
      :confirm-loading="reversalSubmitting"
      :confirm-disabled-reason="reversalDisabledReason"
      danger
      @confirm="submitReversal"
    >
      <section class="v2-payment-reversal-form">
        <el-alert
          v-if="selectedPayment"
          :title="`${selectedPayment.supplierNameSnapshot} · ¥${formatDecimal(
            selectedPayment.creditedCny
          )}`"
          type="warning"
          show-icon
          :closable="false"
        />
        <el-form
          class="v2-horizontal-form"
          label-position="left"
          label-width="92px"
          require-asterisk-position="right"
        >
          <el-form-item label="撤销原因" required>
            <el-input
              v-model="reversalReason"
              type="textarea"
              :rows="3"
              minlength="2"
              maxlength="500"
              show-word-limit
              placeholder="必填，说明付款录错或撤销依据"
            />
          </el-form-item>
        </el-form>
      </section>
    </V2ConfirmDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { idBusinessV2TopupSupplierFundsApi } from '@/v2/api/topupSupplierFunds';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2Decimal } from '@/v2/utils/decimal';
import { operatorUsername } from '@/v2/utils/operator';
import type { V2OptionSelector } from '@/v2/types/options';
import type {
  V2TopupSupplierPaymentItem,
  V2TopupSupplierPaymentListQuery,
  V2TopupSupplierPaymentListResult
} from '@/v2/types/topupSupplierFunds';

defineProps<{
  canManage: boolean;
  suppliers: V2OptionSelector[];
}>();

const items = ref<V2TopupSupplierPaymentItem[]>([]);
const total = ref(0);
const displayedPage = ref(1);
const displayedPageSize = ref(20);
const summary = reactive<V2TopupSupplierPaymentListResult['summary']>({
  activeReceivedUsdt: '0',
  activeNetworkFeeUsdt: '0',
  activeCreditedCny: '0',
  weightedAverageRate: null
});
const query = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  supplierOptionId: '',
  status: '' as '' | 'active' | 'reversed',
  dateRange: [] as string[],
  sortBy: 'paidAt' as NonNullable<V2TopupSupplierPaymentListQuery['sortBy']>,
  sortOrder: 'desc' as 'asc' | 'desc'
});

function getListQuery(): V2TopupSupplierPaymentListQuery {
  return {
    page: query.page,
    pageSize: query.pageSize,
    keyword: query.keyword.trim() || undefined,
    supplierOptionId: query.supplierOptionId || undefined,
    status: query.status || undefined,
    dateFrom: query.dateRange[0] || undefined,
    dateTo: query.dateRange[1] || undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder
  };
}

const paymentsQuery = useV2ModuleQuery<V2TopupSupplierPaymentListResult>({
  moduleKey: 'topup-records',
  scope: 'supplier-payments',
  key: () => createV2QueryKey(getListQuery()),
  keepPreviousData: true,
  query: ({ signal }) => idBusinessV2TopupSupplierFundsApi.listPayments(getListQuery(), { signal })
});
watch(
  paymentsQuery.data,
  (result) => {
    if (!result) return;
    items.value = result.items;
    total.value = result.total;
    displayedPage.value = result.page;
    displayedPageSize.value = result.pageSize;
    Object.assign(summary, result.summary);
  },
  { immediate: true }
);
const loading = computed(
  () => paymentsQuery.isInitialLoading.value || paymentsQuery.isRefreshing.value
);
const queryPhase = paymentsQuery.phase;
const isParameterTransition = paymentsQuery.isParameterTransition;
const error = computed(() =>
  paymentsQuery.error.value ? getApiErrorMessage(paymentsQuery.error.value) : ''
);

const reversalVisible = ref(false);
const reversalSubmitting = ref(false);
const reversalReason = ref('');
const selectedPayment = ref<V2TopupSupplierPaymentItem | null>(null);
const reversalDisabledReason = computed(() => {
  if (!selectedPayment.value) return '未选择付款记录';
  const length = reversalReason.value.trim().length;
  return length >= 2 && length <= 500 ? '' : '撤销原因必须为 2 至 500 个字符';
});

function applyFilters() {
  query.page = 1;
  void paymentsQuery.ensureFresh();
}

function resetFilters() {
  Object.assign(query, {
    page: 1,
    keyword: '',
    supplierOptionId: '',
    status: '',
    dateRange: [],
    sortBy: 'paidAt',
    sortOrder: 'desc'
  });
  void paymentsQuery.ensureFresh();
}

function refresh() {
  return paymentsQuery.refresh();
}

function handlePageChange(page: number) {
  query.page = page;
  void paymentsQuery.ensureFresh();
}

function handlePageSizeChange(pageSize: number) {
  query.pageSize = pageSize;
  query.page = 1;
  void paymentsQuery.ensureFresh();
}

function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
  const supported = [
    'receivedUsdt',
    'settlementRateCnyUsdt',
    'creditedCny',
    'paidAt',
    'createdAt'
  ] as const;
  query.sortBy =
    sort.prop && supported.includes(sort.prop as (typeof supported)[number])
      ? (sort.prop as typeof query.sortBy)
      : 'paidAt';
  query.sortOrder = sort.order === 'ascending' ? 'asc' : 'desc';
  query.page = 1;
  void paymentsQuery.ensureFresh();
}

function openReversal(payment: V2TopupSupplierPaymentItem) {
  selectedPayment.value = payment;
  reversalReason.value = '';
  reversalVisible.value = true;
}

async function submitReversal() {
  const payment = selectedPayment.value;
  if (!payment || reversalSubmitting.value || reversalDisabledReason.value) return;
  reversalSubmitting.value = true;
  try {
    await idBusinessV2TopupSupplierFundsApi.reversePayment(payment.id, {
      reason: reversalReason.value.trim(),
      idempotencyKey: globalThis.crypto.randomUUID()
    });
    ElMessage.success('付款已撤销，供应商余额已通过反向流水扣回');
    reversalVisible.value = false;
    selectedPayment.value = null;
    await refresh();
  } catch (reversalError) {
    ElMessage.error(getApiErrorMessage(reversalError));
  } finally {
    reversalSubmitting.value = false;
  }
}

function formatDecimal(value: string) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}

function formatRate(value: string) {
  return formatV2Decimal(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
</script>
