<template>
  <section class="v2-supplier-funds-panel">
    <header class="v2-supplier-funds-summary" aria-label="供应商资金汇总">
      <article>
        <span>供应商人民币余额</span>
        <strong>¥{{ formatDecimal(summary.totalBalanceCny) }}</strong>
      </article>
      <article>
        <span>已初始化</span>
        <strong>{{ summary.initializedCount }}</strong>
      </article>
      <article>
        <span>未初始化</span>
        <strong>{{ summary.uninitializedCount }}</strong>
      </article>
      <article :class="{ 'is-danger': summary.negativeCount > 0 }">
        <span>负余额供应商</span>
        <strong>{{ summary.negativeCount }}</strong>
      </article>
    </header>

    <section class="v2-supplier-funds-toolbar" aria-label="供应商资金筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="搜索供应商"
        aria-label="搜索加卡供应商"
        @keyup.enter="applyFilters"
        @clear="applyFilters"
      />
      <el-select
        v-model="query.fundingStatus"
        clearable
        placeholder="全部资金状态"
        aria-label="筛选资金状态"
        @change="applyFilters"
      >
        <el-option label="已初始化" value="initialized" />
        <el-option label="未初始化" value="uninitialized" />
        <el-option label="余额为负" value="negative" />
      </el-select>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="应用筛选" @click="applyFilters">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新供应商资金" :disabled="loading" @click="refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :phase="queryPhase"
      :previous-data="isParameterTransition"
      :error="error"
      loading-title="正在加载供应商资金"
      refreshing-title="正在更新供应商资金"
      error-title="供应商资金加载失败"
      @retry="refresh"
    >
      <V2Table
        :schema="v2TableSchemas.topupRecords.supplierFunds"
        class="v2-records-table"
        :data="items"
        scrollbar-always-on
        show-overflow-tooltip
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无加卡供应商</strong>
            <span>请先在选项设置中新增加卡供应商</span>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[0]">
          <template #default="{ row }">
            <strong>{{ row.supplier.name }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[1]">
          <template #default="{ row }">
            <el-tag v-if="!row.initialized" type="info" effect="plain">未初始化</el-tag>
            <el-tag v-else-if="row.isNegative" type="danger" effect="plain">余额为负</el-tag>
            <el-tag v-else type="success" effect="plain">正常</el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[2]">
          <template #default="{ row }">
            <strong
              v-if="row.currentBalanceCny !== null"
              :class="{ 'is-negative': row.isNegative }"
            >
              ¥{{ formatDecimal(row.currentBalanceCny) }}
            </strong>
            <span v-else>—</span>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[3]">
          <template #default="{ row }">¥{{ formatDecimal(row.paymentsCny) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[4]">
          <template #default="{ row }">¥{{ formatDecimal(row.topupDeductionsCny) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[5]">
          <template #default="{ row }">{{ formatSignedCurrency(row.netAdjustmentsCny) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[6]">
          <template #default="{ row }">{{ formatOptionalDate(row.lastPaymentAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[7]">
          <template #default="{ row }">{{ formatOptionalDate(row.lastTopupAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.topupRecords.supplierFunds.columns[8]">
          <template #default="{ row }">
            <AppButton size="small" variant="ghost" @click="openDetails(row)">明细</AppButton>
            <template v-if="canManage">
              <AppButton
                v-if="!row.initialized"
                size="small"
                variant="primary"
                @click="openMutation(row, 'initialize')"
              >
                初始化
              </AppButton>
              <template v-else>
                <AppButton size="small" variant="soft" @click="openMutation(row, 'payment')">
                  记录付款
                </AppButton>
                <AppButton size="small" variant="ghost" @click="openMutation(row, 'adjust')">
                  调整余额
                </AppButton>
              </template>
            </template>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div
        class="v2-records-mobile-list"
        :data-mobile-for="v2TableSchemas.topupRecords.supplierFunds.id"
      >
        <V2TopupSupplierFundsMobileList
          :items="items"
          :can-manage="canManage"
          @details="openDetails"
          @mutation="openMutation"
        />
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ total }} 个供应商</span>
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
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="mutationDrawerVisible"
      :title="mutationTitle"
      :confirm-text="mutationConfirmText"
      :confirm-loading="submitting"
      :confirm-disabled="!selectedSupplier"
      :dirty="mutationDirty"
      @confirm="submitMutation"
    >
      <section v-if="selectedSupplier" class="v2-supplier-fund-form">
        <header>
          <span>加卡供应商</span>
          <strong>{{ selectedSupplier.supplier.name }}</strong>
          <small>
            当前余额：
            {{
              selectedSupplier.currentBalanceCny === null
                ? '未初始化'
                : `¥${formatDecimal(selectedSupplier.currentBalanceCny)}`
            }}
          </small>
        </header>
        <el-form
          class="v2-horizontal-form"
          label-position="left"
          label-width="124px"
          require-asterisk-position="right"
        >
          <template v-if="mutationMode === 'payment'">
            <el-form-item label="到账 USDT" required>
              <el-input
                v-model="paymentForm.receivedUsdt"
                inputmode="decimal"
                placeholder="例如 1000"
              />
            </el-form-item>
            <el-form-item label="结算汇率" required>
              <el-input
                v-model="paymentForm.settlementRateCnyUsdt"
                inputmode="decimal"
                placeholder="例如 6.8"
              />
            </el-form-item>
            <el-form-item label="折算人民币">
              <strong>¥{{ formatDecimal(paymentPreviewCny) }}</strong>
            </el-form-item>
            <el-form-item label="网络手续费 USDT">
              <el-input
                v-model="paymentForm.networkFeeUsdt"
                inputmode="decimal"
                placeholder="选填，不计入供应商余额"
              />
            </el-form-item>
            <el-form-item label="网络">
              <el-input v-model="paymentForm.network" maxlength="40" placeholder="例如 TRC20" />
            </el-form-item>
            <el-form-item label="交易哈希">
              <el-input
                v-model="paymentForm.transactionHash"
                maxlength="180"
                placeholder="选填，链上交易哈希"
              />
            </el-form-item>
            <el-form-item label="实际付款时间" required>
              <el-input v-model="paymentForm.paidAt" type="datetime-local" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input
                v-model="paymentForm.remark"
                type="textarea"
                :rows="3"
                maxlength="2000"
                show-word-limit
              />
            </el-form-item>
          </template>
          <template v-else>
            <el-form-item
              :label="mutationMode === 'initialize' ? '期初人民币余额' : '调整后正确余额'"
              required
            >
              <el-input
                v-model="balanceForm.targetBalanceCny"
                inputmode="decimal"
                placeholder="允许填写负数"
              />
            </el-form-item>
            <el-form-item label="操作原因" required>
              <el-input
                v-model="balanceForm.reason"
                type="textarea"
                :rows="3"
                minlength="2"
                maxlength="500"
                show-word-limit
                placeholder="必填，说明期初依据或调账原因"
              />
            </el-form-item>
          </template>
        </el-form>
      </section>
    </V2FormDrawer>

    <V2TopupSupplierFundDetailsDrawer ref="detailsDrawer" />
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TopupSupplierFundDetailsDrawer from './V2TopupSupplierFundDetailsDrawer.vue';
import V2TopupSupplierFundsMobileList from './V2TopupSupplierFundsMobileList.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { idBusinessV2TopupSupplierFundsApi } from '@/v2/api/topupSupplierFunds';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { ensureV2BusinessNowInput } from '@/v2/runtime/businessClock';
import { isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import {
  formatOptionalSupplierFundDate as formatOptionalDate,
  formatSupplierFundDecimal as formatDecimal,
  formatSupplierFundSignedCurrency as formatSignedCurrency
} from '../topup-supplier-fund-format';
import { parseV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import type {
  V2TopupSupplierFundItem,
  V2TopupSupplierFundListQuery,
  V2TopupSupplierFundSummary
} from '@/v2/types/topupSupplierFunds';

defineProps<{ canManage: boolean }>();

type MutationMode = 'initialize' | 'payment' | 'adjust';

const items = ref<V2TopupSupplierFundItem[]>([]);
const total = ref(0);
const displayedPage = ref(1);
const displayedPageSize = ref(20);
const summary = reactive<V2TopupSupplierFundSummary>({
  totalBalanceCny: '0',
  initializedCount: 0,
  uninitializedCount: 0,
  negativeCount: 0
});
const query = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  fundingStatus: '' as '' | 'initialized' | 'uninitialized' | 'negative'
});

function getListQuery(): V2TopupSupplierFundListQuery {
  return {
    page: query.page,
    pageSize: query.pageSize,
    keyword: query.keyword.trim() || undefined,
    fundingStatus: query.fundingStatus || undefined
  };
}

const fundsQuery = useV2ModuleQuery({
  moduleKey: 'topup-records',
  scope: 'supplier-funds',
  key: () => createV2QueryKey(getListQuery()),
  keepPreviousData: true,
  query: ({ signal }) => idBusinessV2TopupSupplierFundsApi.listSuppliers(getListQuery(), { signal })
});
watch(
  fundsQuery.data,
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
const loading = computed(() => fundsQuery.isInitialLoading.value || fundsQuery.isRefreshing.value);
const queryPhase = fundsQuery.phase;
const isParameterTransition = fundsQuery.isParameterTransition;
const error = computed(() =>
  fundsQuery.error.value ? getApiErrorMessage(fundsQuery.error.value) : ''
);

const mutationDrawerVisible = ref(false);
const mutationMode = ref<MutationMode>('initialize');
const selectedSupplier = ref<V2TopupSupplierFundItem | null>(null);
const submitting = ref(false);
const balanceForm = reactive({ targetBalanceCny: '', reason: '', idempotencyKey: '' });
const paymentForm = reactive({
  receivedUsdt: '',
  networkFeeUsdt: '',
  settlementRateCnyUsdt: '',
  network: '',
  transactionHash: '',
  paidAt: '',
  remark: '',
  idempotencyKey: ''
});
const mutationTitle = computed(() => {
  const label =
    mutationMode.value === 'initialize'
      ? '初始化供应商资金'
      : mutationMode.value === 'payment'
        ? '记录供应商付款'
        : '调整供应商余额';
  return `${label}${selectedSupplier.value ? ` · ${selectedSupplier.value.supplier.name}` : ''}`;
});
const mutationConfirmText = computed(() =>
  mutationMode.value === 'payment'
    ? '确认付款入账'
    : mutationMode.value === 'initialize'
      ? '确认初始化'
      : '确认调整'
);
const paymentPreviewCny = computed(() => {
  if (
    !isV2UnsignedDecimal(paymentForm.receivedUsdt, { allowZero: false }) ||
    !isV2UnsignedDecimal(paymentForm.settlementRateCnyUsdt, {
      allowZero: false,
      decimalPlaces: 8
    })
  ) {
    return '0';
  }
  return multiplyDecimalStrings(paymentForm.receivedUsdt, paymentForm.settlementRateCnyUsdt);
});
const mutationDirty = computed(() =>
  mutationMode.value === 'payment'
    ? Boolean(
        paymentForm.receivedUsdt ||
        paymentForm.networkFeeUsdt ||
        paymentForm.settlementRateCnyUsdt ||
        paymentForm.network ||
        paymentForm.transactionHash ||
        paymentForm.remark
      )
    : mutationMode.value === 'adjust'
      ? balanceForm.targetBalanceCny !== (selectedSupplier.value?.currentBalanceCny ?? '') ||
        Boolean(balanceForm.reason)
      : Boolean(balanceForm.targetBalanceCny || balanceForm.reason)
);

const detailsDrawer = ref<InstanceType<typeof V2TopupSupplierFundDetailsDrawer>>();

function applyFilters() {
  query.page = 1;
  void fundsQuery.ensureFresh();
}

function resetFilters() {
  Object.assign(query, { page: 1, keyword: '', fundingStatus: '' });
  void fundsQuery.ensureFresh();
}

function refresh() {
  return fundsQuery.refresh();
}

function handlePageChange(page: number) {
  query.page = page;
  void fundsQuery.ensureFresh();
}

function handlePageSizeChange(pageSize: number) {
  query.pageSize = pageSize;
  query.page = 1;
  void fundsQuery.ensureFresh();
}

async function openMutation(item: V2TopupSupplierFundItem, mode: MutationMode) {
  const paidAt = await ensureV2BusinessNowInput();
  if (!paidAt) {
    ElMessage.error('无法读取服务器北京时间，请稍后重试');
    return;
  }
  selectedSupplier.value = item;
  mutationMode.value = mode;
  Object.assign(balanceForm, {
    targetBalanceCny: mode === 'adjust' ? (item.currentBalanceCny ?? '') : '',
    reason: '',
    idempotencyKey: createIdempotencyKey()
  });
  Object.assign(paymentForm, {
    receivedUsdt: '',
    networkFeeUsdt: '',
    settlementRateCnyUsdt: '',
    network: '',
    transactionHash: '',
    paidAt,
    remark: '',
    idempotencyKey: createIdempotencyKey()
  });
  mutationDrawerVisible.value = true;
}

async function submitMutation() {
  const item = selectedSupplier.value;
  if (!item || submitting.value) return;
  if (!validateMutation()) return;
  submitting.value = true;
  try {
    if (mutationMode.value === 'initialize') {
      await idBusinessV2TopupSupplierFundsApi.initialize(item.supplier.id, {
        targetBalanceCny: balanceForm.targetBalanceCny.trim(),
        reason: balanceForm.reason.trim(),
        idempotencyKey: balanceForm.idempotencyKey
      });
      ElMessage.success('供应商期初余额已建立');
    } else if (mutationMode.value === 'adjust') {
      await idBusinessV2TopupSupplierFundsApi.adjust(item.supplier.id, {
        targetBalanceCny: balanceForm.targetBalanceCny.trim(),
        reason: balanceForm.reason.trim(),
        idempotencyKey: balanceForm.idempotencyKey
      });
      ElMessage.success('供应商余额已调整并记录流水');
    } else {
      await idBusinessV2TopupSupplierFundsApi.createPayment(item.supplier.id, {
        receivedUsdt: paymentForm.receivedUsdt.trim(),
        ...(paymentForm.networkFeeUsdt.trim()
          ? { networkFeeUsdt: paymentForm.networkFeeUsdt.trim() }
          : {}),
        settlementRateCnyUsdt: paymentForm.settlementRateCnyUsdt.trim(),
        ...(paymentForm.network.trim() ? { network: paymentForm.network.trim() } : {}),
        ...(paymentForm.transactionHash.trim()
          ? { transactionHash: paymentForm.transactionHash.trim() }
          : {}),
        paidAt: v2DateTimeInputToIso(paymentForm.paidAt),
        ...(paymentForm.remark.trim() ? { remark: paymentForm.remark.trim() } : {}),
        idempotencyKey: paymentForm.idempotencyKey
      });
      ElMessage.success(`付款已入账，增加人民币 ¥${formatDecimal(paymentPreviewCny.value)}`);
    }
    mutationDrawerVisible.value = false;
    await refresh();
  } catch (mutationError) {
    ElMessage.error(getApiErrorMessage(mutationError));
  } finally {
    submitting.value = false;
  }
}

function validateMutation() {
  if (mutationMode.value === 'payment') {
    if (!isV2UnsignedDecimal(paymentForm.receivedUsdt, { allowZero: false })) {
      ElMessage.warning('到账 USDT 必须是最多 4 位小数的正数');
      return false;
    }
    if (
      !isV2UnsignedDecimal(paymentForm.settlementRateCnyUsdt, {
        allowZero: false,
        decimalPlaces: 8
      })
    ) {
      ElMessage.warning('结算汇率必须是最多 8 位小数的正数');
      return false;
    }
    if (paymentForm.networkFeeUsdt.trim() && !isV2UnsignedDecimal(paymentForm.networkFeeUsdt)) {
      ElMessage.warning('网络手续费必须是最多 4 位小数的非负数字');
      return false;
    }
    if (!parseV2DateTimeInput(paymentForm.paidAt)) {
      ElMessage.warning('请选择有效的实际付款时间');
      return false;
    }
    return true;
  }
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(balanceForm.targetBalanceCny.trim())) {
    ElMessage.warning('人民币余额必须是最多 4 位小数的有效金额');
    return false;
  }
  if (balanceForm.reason.trim().length < 2) {
    ElMessage.warning('操作原因至少填写 2 个字符');
    return false;
  }
  return true;
}

function openDetails(item: V2TopupSupplierFundItem) {
  detailsDrawer.value?.open(item);
}

function createIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}
</script>
