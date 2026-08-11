<template>
  <section class="v2-analytics-section-stack" aria-label="资产余额分析">
    <section class="v2-finance-asset-overview" aria-label="资产总览">
      <article class="is-primary">
        <span>资产账面合计</span>
        <strong>{{ formatCny(overview.assets.totalBookValueCny) }}</strong>
        <small>以历史交易汇率记录</small>
      </article>
      <article>
        <span>最新人民币估值</span>
        <strong>
          {{
            overview.assets.totalLatestValuationCny === null
              ? '汇率不完整'
              : formatCny(overview.assets.totalLatestValuationCny)
          }}
        </strong>
        <small>只用于当前资产估值</small>
      </article>
      <article>
        <span>未实现汇兑变化</span>
        <strong :class="amountTone(overview.assets.unrealizedFxChangeCny)">
          {{
            overview.assets.unrealizedFxChangeCny === null
              ? '—'
              : formatCny(overview.assets.unrealizedFxChangeCny)
          }}
        </strong>
        <small>不进入经营净利润</small>
      </article>
    </section>

    <article class="v2-finance-panel v2-analytics-asset-composition">
      <header>
        <V2SectionHeading
          title="资产构成"
          help="展示自有资金、卡商预付款、余额资产、ID 库存和待卡商退款的账面人民币金额。"
        >
          <template #actions>
            <span>共 {{ assetRows.length }} 类资产</span>
          </template>
        </V2SectionHeading>
      </header>
      <dl class="v2-finance-asset-list">
        <div v-for="item in assetRows" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd>{{ formatCny(item.value) }}</dd>
        </div>
      </dl>
    </article>

    <section ref="listRef" class="v2-analytics-report-list v2-records-list" :style="listFrameStyle">
      <header class="v2-analytics-report-list__header">
        <V2SectionHeading
          title="卡商资金"
          help="充值不计亏损，购卡、退款与调整形成供应商钱包余额变化。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.dataAnalytics.supplierWallets" />
            <span>本页 {{ wallets.length }} 条</span>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.dataAnalytics.supplierWallets"
        :show-column-settings="false"
        class="v2-records-table"
        :data="wallets"
        scrollbar-always-on
        show-overflow-tooltip
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无卡商钱包</strong>
            <span>请到财务记账创建供应商多币种钱包</span>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[0]">
          <template #default="{ row }"
            ><strong>{{ row.supplierName }}</strong></template
          >
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[1]">
          <template #default="{ row }"
            ><el-tag effect="plain">{{ row.currency }}</el-tag></template
          >
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[2]">
          <template #default="{ row }">{{
            formatOriginal(row.openingBalance, row.currency)
          }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[3]">
          <template #default="{ row }">
            <strong>{{ formatOriginal(row.currentBalance, row.currency) }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[4]">
          <template #default="{ row }">{{ formatCny(row.currentBalanceCny) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.supplierWallets.columns[5]">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </V2TableColumn>
      </V2Table>
    </section>
  </section>
</template>

<script setup lang="ts">
import type {
  V2FinanceCurrency,
  V2FinanceOverview,
  V2FinanceSupplierWallet
} from '@apple-business/shared';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';

const props = defineProps<{
  overview: V2FinanceOverview;
  assetRows: Array<{ label: string; value: string }>;
  wallets: V2FinanceSupplierWallet[];
  formatCny: (value: string | null | undefined) => string;
  formatOriginal: (value: string, currency: V2FinanceCurrency) => string;
  amountTone: (value: string | null | undefined) => string;
}>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.wallets,
  pageSize: () => 10
});
</script>
