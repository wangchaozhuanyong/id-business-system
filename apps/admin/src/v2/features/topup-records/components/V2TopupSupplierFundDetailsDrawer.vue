<template>
  <el-drawer
    v-model="visible"
    :title="`${supplier?.supplier.name ?? ''} · 资金明细`"
    size="min(860px, 96vw)"
    destroy-on-close
  >
    <V2AsyncRegion
      skeleton="detail"
      :loading="loading"
      :resolved="resolved"
      :error="error"
      loading-title="正在加载供应商资金明细"
      refreshing-title="正在更新供应商资金明细"
      error-title="供应商资金明细加载失败"
      @retry="load"
    >
      <section v-if="detail" class="v2-supplier-fund-details">
        <header>
          <div>
            <span>当前人民币余额</span>
            <strong :class="{ 'is-negative': detail.account?.isNegative }">
              {{
                detail.account ? `¥${formatDecimal(detail.account.currentBalanceCny)}` : '未初始化'
              }}
            </strong>
          </div>
        </header>
        <section v-if="detail.countryStats.length" class="v2-supplier-country-stats">
          <article v-for="country in detail.countryStats" :key="country.countryOptionId">
            <strong>{{ country.countryName }}</strong>
            <span>{{ country.cardCount }} 张卡</span>
            <span>
              面值 {{ formatDecimal(country.faceValue) }}
              {{ country.currencyCode || '' }}
            </span>
            <span>人民币成本 ¥{{ formatDecimal(country.costCny) }}</span>
          </article>
        </section>
        <V2Table
          :schema="v2TableSchemas.topupRecords.supplierFundDetails"
          :data="detail.items"
          scrollbar-always-on
          show-overflow-tooltip
        >
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[0]">
            <template #default="{ row }">{{ ledgerTypeLabel(row.entryType) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[1]">
            <template #default="{ row }">{{ formatSignedCurrency(row.balanceDeltaCny) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[2]">
            <template #default="{ row }">¥{{ formatDecimal(row.balanceBeforeCny) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[3]">
            <template #default="{ row }">¥{{ formatDecimal(row.balanceAfterCny) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[4]">
            <template #default="{ row }">
              {{
                row.giftCard?.codeMasked ||
                (row.payment ? `付款 ${row.payment.id.slice(0, 8)}` : '—')
              }}
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[5]">
            <template #default="{ row }">{{ row.reason || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.topupRecords.supplierFundDetails.columns[6]">
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </V2TableColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ detail.total }} 条</span>
          <el-pagination
            v-model:current-page="query.page"
            v-model:page-size="query.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="detail.total"
            @current-change="load"
            @size-change="handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>
  </el-drawer>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { idBusinessV2TopupSupplierFundsApi } from '@/v2/api/topupSupplierFunds';
import {
  formatSupplierFundDate as formatDate,
  formatSupplierFundDecimal as formatDecimal,
  formatSupplierFundSignedCurrency as formatSignedCurrency
} from '../topup-supplier-fund-format';
import type {
  V2TopupSupplierFundItem,
  V2TopupSupplierLedgerEntryType,
  V2TopupSupplierLedgerResult
} from '@/v2/types/topupSupplierFunds';
import { useV2LatestRequest } from '@/v2/composables/useV2LatestRequest';

const visible = ref(false);
const supplier = ref<V2TopupSupplierFundItem | null>(null);
const detail = ref<V2TopupSupplierLedgerResult | null>(null);
const loading = ref(false);
const resolved = ref(false);
const error = ref('');
const query = reactive({ page: 1, pageSize: 20 });
const latestRequest = useV2LatestRequest();

function open(item: V2TopupSupplierFundItem) {
  const switchingTarget = supplier.value?.supplier.id !== item.supplier.id;
  supplier.value = item;
  visible.value = true;
  query.page = 1;
  if (switchingTarget) {
    detail.value = null;
    resolved.value = false;
  }
  void load();
}

async function load() {
  if (!supplier.value) return;
  const supplierId = supplier.value.supplier.id;
  const request = latestRequest.begin();
  loading.value = true;
  error.value = '';
  try {
    const result = await idBusinessV2TopupSupplierFundsApi.listLedger(supplierId, query, {
      signal: request.signal
    });
    if (!request.isCurrent() || supplier.value?.supplier.id !== supplierId) return;
    detail.value = result;
    resolved.value = true;
  } catch (loadError) {
    if (!request.isCurrent() || supplier.value?.supplier.id !== supplierId) return;
    error.value = getApiErrorMessage(loadError);
  } finally {
    if (request.isCurrent() && supplier.value?.supplier.id === supplierId) {
      loading.value = false;
    }
    request.finish();
  }
}

function handlePageSizeChange() {
  query.page = 1;
  void load();
}

function ledgerTypeLabel(type: V2TopupSupplierLedgerEntryType) {
  return {
    opening_balance: '期初余额',
    payment_credit: '付款增加',
    gift_card_debit: '加卡扣减',
    id_purchase_debit: 'ID 采购扣减',
    gift_card_withdrawal_reversal: '加卡返还',
    manual_adjustment: '人工调账',
    payment_reversal: '付款撤销'
  }[type];
}

defineExpose({ open });
</script>
