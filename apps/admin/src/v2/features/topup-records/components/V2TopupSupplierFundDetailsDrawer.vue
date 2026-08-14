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
        <V2DetailSummary
          heading-id="supplier-fund-detail-summary"
          eyebrow="供应商资金"
          :title="supplier?.supplier.name || '供应商'"
          description="集中核对余额变化、入库卡片和每笔资金依据"
          :metrics="[
            {
              label: '当前人民币余额',
              value: detail.account
                ? `¥${formatDecimal(detail.account.currentBalanceCny)}`
                : '未初始化',
              tone: detail.account?.isNegative ? 'negative' : undefined
            },
            { label: '资金流水', value: `${detail.total} 条` }
          ]"
          :facts="[
            { label: '卡片国家/地区', value: `${detail.countryStats.length} 个` },
            { label: '当前页', value: `第 ${displayedPage} 页` },
            { label: '每页数量', value: `${displayedPageSize} 条` }
          ]"
        />
        <V2PanelSection heading-id="supplier-fund-country-stats" title="在库卡片概览" step="01">
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
          <el-empty v-else description="当前没有在库卡片统计" :image-size="72" />
        </V2PanelSection>
        <V2PanelSection heading-id="supplier-fund-ledger" title="资金流水" step="02">
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
              <template #default="{ row }">{{
                formatSignedCurrency(row.balanceDeltaCny)
              }}</template>
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
                  row.giftCard?.code || (row.payment ? `付款 ${row.payment.id.slice(0, 8)}` : '—')
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
              v-pagination-label
              :current-page="displayedPage"
              :page-size="displayedPageSize"
              background
              :page-sizes="[10, 20, 50, 100]"
              layout="sizes, prev, pager, next"
              :total="detail.total"
              :disabled="loading"
              @current-change="handlePageChange"
              @size-change="handlePageSizeChange"
            />
          </footer>
        </V2PanelSection>
      </section>
    </V2AsyncRegion>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
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
const displayedPage = computed(() => detail.value?.page ?? query.page);
const displayedPageSize = computed(() => detail.value?.pageSize ?? query.pageSize);

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

function handlePageChange(page: number) {
  query.page = page;
  void load();
}

function handlePageSizeChange(pageSize: number) {
  query.pageSize = pageSize;
  query.page = 1;
  void load();
}

watch(visible, (isVisible) => {
  if (isVisible) return;
  latestRequest.cancel();
  loading.value = false;
  resolved.value = false;
  error.value = '';
  detail.value = null;
  supplier.value = null;
});

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
