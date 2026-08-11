<template>
  <section ref="listRef" class="v2-finance-ledger-list v2-records-list" :style="listFrameStyle">
    <header class="v2-finance-ledger-list__header">
      <V2SectionHeading
        title="供应商钱包列表"
        help="每个供应商可按币种建立独立钱包；充值、退款和余额调整仍按原权限与记账流程执行。"
      >
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.financeLedger.supplierWallets" />
          <span>本页 {{ page.wallets.length }} 条</span>
        </template>
      </V2SectionHeading>
    </header>

    <V2Table
      :schema="v2TableSchemas.financeLedger.supplierWallets"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.wallets"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <FinanceEmpty title="暂无供应商钱包" description="一个供应商可按币种分别建立钱包" />
      </template>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[0]">
        <template #default="{ row }"
          ><strong>{{ row.supplierName }}</strong></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[1]">
        <template #default="{ row }"
          ><el-tag effect="plain">{{ row.currency }}</el-tag></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[2]">
        <template #default="{ row }">{{
          formatOriginal(row.openingBalance, row.currency)
        }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[3]">
        <template #default="{ row }">
          <strong>{{ formatOriginal(row.currentBalance, row.currency) }}</strong>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[4]">
        <template #default="{ row }">{{ formatCny(row.currentBalanceCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.supplierWallets.columns[5]">
        <template #default="{ row }">{{ formatDate(row.initializedAt) }}</template>
      </V2TableColumn>
      <V2TableActionColumn
        v-if="page.canPost || page.canAdjust"
        :definition="v2TableSchemas.financeLedger.supplierWallets.columns[6]"
      >
        <template #default="{ row }">
          <el-dropdown trigger="click" @command="handleWalletMutationCommand(row, $event)">
            <AppButton size="small" variant="ghost">更多操作</AppButton>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="page.canPost" command="deposit"
                  >供应商充值</el-dropdown-item
                >
                <el-dropdown-item v-if="page.canPost" command="refund"
                  >收到供应商退款</el-dropdown-item
                >
                <el-dropdown-item v-if="page.canAdjust" command="adjust" divided
                  >余额调整</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
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
import type { V2FinanceSupplierWallet } from '../contracts';
import { formatCny, formatDate, formatOriginal } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.wallets,
  pageSize: () => props.page.pageSize
});

function handleWalletMutationCommand(row: V2FinanceSupplierWallet, command: unknown) {
  if (command === 'deposit' || command === 'refund' || command === 'adjust') {
    props.page.openWalletMutation(row, command);
  }
}
</script>
