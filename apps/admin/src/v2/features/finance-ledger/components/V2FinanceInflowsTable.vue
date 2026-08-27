<template>
  <section ref="listRef" class="v2-finance-expenses-list v2-records-list" :style="listFrameStyle">
    <header class="v2-finance-expenses-list__header">
      <V2SectionHeading
        title="收入记录"
        help="经营收入影响利润；股东投入和借入资金只增加现金，不计入经营利润。"
      >
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.financeLedger.inflows" />
          <span>本页 {{ page.inflows.length }} 条</span>
          <span aria-hidden="true">·</span>
          <strong>共 {{ page.inflowTotal }} 条</strong>
        </template>
      </V2SectionHeading>
    </header>

    <V2Table
      :schema="v2TableSchemas.financeLedger.inflows"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.inflows"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <FinanceEmpty title="暂无收入记录" description="经营收入、股东投入和借入资金在这里入账" />
      </template>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[0]">
        <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[1]">
        <template #default="{ row }">
          <el-tag :type="inflowNatureTagType(row.nature)" effect="plain">
            {{ inflowNatureLabel(row.nature) }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[2]">
        <template #default="{ row }">{{ row.categoryName || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[3]">
        <template #default="{ row }">{{ row.financeAccountName }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[4]">
        <template #default="{ row }">{{
          formatOriginal(row.amountOriginal, row.currency)
        }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[5]">
        <template #default="{ row }">{{ row.fxRateToCny }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[6]">
        <template #default="{ row }">{{ formatCny(row.amountCny) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[7]">
        <template #default="{ row }">{{ row.payer || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[8]">
        <template #default="{ row }">{{ row.externalReference || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[9]">
        <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[10]">
        <template #default="{ row }">{{ row.remark || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.inflows.columns[11]">
        <template #default="{ row }">
          <el-tag :type="row.status === 'reversed' ? 'info' : 'success'" effect="plain">
            {{ row.status === 'reversed' ? '已冲销' : '已入账' }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableActionColumn :definition="v2TableSchemas.financeLedger.inflows.columns[12]">
        <template #default="{ row }">
          <AppButton
            size="small"
            variant="ghost"
            :disabled="!row.receiptAttachment"
            :loading="page.receiptDownloadingId === row.id"
            @click="page.viewInflowReceipt(row)"
          >
            {{ row.receiptAttachment ? '查看凭证' : '无凭证' }}
          </AppButton>
          <AppButton
            v-if="page.canAdjust && page.canPost"
            size="small"
            variant="ghost"
            :disabled="row.status === 'reversed'"
            @click="page.openInflow(row)"
          >
            更正
          </AppButton>
        </template>
      </V2TableActionColumn>
    </V2Table>
    <footer class="v2-records-pagination">
      <span>第 {{ page.displayedInflowPage }} 页</span>
      <el-pagination
        :current-page="page.displayedInflowPage"
        :page-size="page.pageSize"
        background
        layout="prev, pager, next"
        :total="page.inflowTotal"
        :disabled="page.queryPhase === 'transitioning'"
        @current-change="page.setInflowPage"
      />
    </footer>
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
import { operatorUsername } from '@/v2/utils/operator';
import {
  formatCny,
  formatDate,
  formatOriginal,
  inflowNatureLabel,
  inflowNatureTagType
} from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.inflows,
  pageSize: () => props.page.pageSize
});
</script>
