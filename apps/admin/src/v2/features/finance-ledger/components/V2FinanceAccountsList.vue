<template>
  <section ref="listRef" class="v2-finance-ledger-list v2-records-list" :style="listFrameStyle">
    <header class="v2-finance-ledger-list__header">
      <V2SectionHeading
        title="资金账户列表"
        help="查看账户币种、期初余额、当前余额和启停状态；编辑权限继续由财务管理权限控制。"
      >
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.financeLedger.accounts" />
          <span>本页 {{ page.accounts.length }} 条</span>
        </template>
      </V2SectionHeading>
    </header>

    <V2Table
      :schema="v2TableSchemas.financeLedger.accounts"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.accounts"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <FinanceEmpty title="暂无资金账户" description="先建立银行卡、现金或钱包账户" />
      </template>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[0]">
        <template #default="{ row }"
          ><strong>{{ row.name }}</strong></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[1]">
        <template #default="{ row }">{{ accountTypeLabel(row.accountType) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[2]">
        <template #default="{ row }"
          ><el-tag effect="plain">{{ row.currency }}</el-tag></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[3]">
        <template #default="{ row }">{{
          formatOriginal(row.openingBalance, row.currency)
        }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[4]">
        <template #default="{ row }">
          <strong :class="amountTone(row.currentBalance)">
            {{ formatOriginal(row.currentBalance, row.currency) }}
          </strong>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[5]">
        <template #default="{ row }">{{ formatCny(row.currentBalanceCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.accounts.columns[6]">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableActionColumn
        v-if="page.canManage"
        :definition="v2TableSchemas.financeLedger.accounts.columns[7]"
      >
        <template #default="{ row }">
          <AppButton size="small" variant="ghost" @click="page.openAccount(row)">编辑</AppButton>
        </template>
      </V2TableActionColumn>
    </V2Table>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import {
  accountTypeLabel,
  amountTone,
  formatCny,
  formatOriginal
} from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.accounts,
  pageSize: () => props.page.pageSize
});
</script>
