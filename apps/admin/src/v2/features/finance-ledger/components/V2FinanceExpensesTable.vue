<template>
  <V2Table
    :schema="v2TableSchemas.financeLedger.expenses"
    class="v2-records-table"
    :data="page.expenses"
    scrollbar-always-on
    show-overflow-tooltip
  >
    <template #empty>
      <FinanceEmpty title="暂无开支记录" description="手机、办公、工资等开支在这里入账" />
    </template>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[0]">
      <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[1]">
      <template #default="{ row }"
        ><strong>{{ row.categoryName }}</strong></template
      >
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[2]">
      <template #default="{ row }">{{ row.financeAccountName }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[3]">
      <template #default="{ row }">{{ formatOriginal(row.amountOriginal, row.currency) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[4]">
      <template #default="{ row }">{{ row.fxRateToCny }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[5]">
      <template #default="{ row }">{{ formatCny(row.amountCny) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[6]">
      <template #default="{ row }">{{ row.payee || '—' }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[7]">
      <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[8]">
      <template #default="{ row }">{{ row.remark || '—' }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.financeLedger.expenses.columns[9]">
      <template #default="{ row }">
        <el-tag :type="row.status === 'reversed' ? 'info' : 'success'" effect="plain">
          {{ row.status === 'reversed' ? '已冲销' : '已入账' }}
        </el-tag>
      </template>
    </V2TableColumn>
    <V2TableActionColumn
      v-if="page.canAdjust && page.canPost"
      :definition="v2TableSchemas.financeLedger.expenses.columns[10]"
    >
      <template #default="{ row }">
        <AppButton
          size="small"
          variant="ghost"
          :disabled="row.status === 'reversed'"
          @click="page.openExpense(row)"
        >
          更正
        </AppButton>
      </template>
    </V2TableActionColumn>
  </V2Table>
  <footer class="v2-records-pagination">
    <span>共 {{ page.expenseTotal }} 条</span>
    <el-pagination
      :current-page="page.expensePage"
      :page-size="page.pageSize"
      background
      layout="prev, pager, next"
      :total="page.expenseTotal"
      @current-change="page.setExpensePage"
    />
  </footer>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { operatorUsername } from '@/v2/utils/operator';
import { formatCny, formatDate, formatOriginal } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();
</script>
