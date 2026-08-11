<template>
  <section ref="listRef" class="v2-finance-ledger-list v2-records-list" :style="listFrameStyle">
    <header class="v2-finance-ledger-list__header">
      <V2SectionHeading
        title="不可变流水列表"
        :help="journalReversalHelp"
        placement="bottom"
        :width="360"
      >
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.financeLedger.journals" />
          <span>本页 {{ page.journals.length }} 条</span>
          <span aria-hidden="true">·</span>
          <strong>共 {{ page.journalTotal }} 条</strong>
        </template>
      </V2SectionHeading>
    </header>

    <V2Table
      :schema="v2TableSchemas.financeLedger.journals"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.journals"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <FinanceEmpty title="暂无财务流水" description="业务完成或手工记账后自动生成" />
      </template>
      <V2TableControlColumn :definition="v2TableSchemas.financeLedger.journals.columns[0]">
        <template #default="{ row }">
          <div class="v2-finance-lines">
            <div v-for="line in row.lines" :key="line.id">
              <span>{{ accountCodeLabel(line.accountCode) }}</span>
              <strong>{{ line.direction === 'debit' ? '借' : '贷' }}</strong>
              <span>{{ formatOriginal(line.amountOriginal, line.currency) }}</span>
              <span>{{ formatCny(line.amountCny) }}</span>
              <span>{{ line.memo || '—' }}</span>
            </div>
          </div>
        </template>
      </V2TableControlColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.journals.columns[1]">
        <template #default="{ row }"
          ><strong>{{ row.journalNo }}</strong></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.journals.columns[2]">
        <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.journals.columns[3]">
        <template #default="{ row }"
          ><el-tag effect="plain">{{ journalTypeLabel(row.journalType) }}</el-tag></template
        >
      </V2TableColumn>
      <V2TableColumn
        :definition="v2TableSchemas.financeLedger.journals.columns[4]"
        prop="summary"
      />
      <V2TableColumn :definition="v2TableSchemas.financeLedger.journals.columns[5]">
        <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.journals.columns[6]">
        <template #default="{ row }">
          <el-tag :type="row.status === 'posted' ? 'success' : 'info'" effect="plain">
            {{ row.status === 'posted' ? '已发布' : '已冲销' }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableActionColumn
        v-if="page.canAdjust"
        :definition="v2TableSchemas.financeLedger.journals.columns[7]"
      >
        <template #default="{ row }">
          <AppButton
            size="small"
            variant="ghost"
            :disabled="row.status !== 'posted' || row.journalType === 'reversal'"
            @click="page.openReversal(row)"
          >
            冲销
          </AppButton>
        </template>
      </V2TableActionColumn>
    </V2Table>

    <footer class="v2-records-pagination">
      <span>共 {{ page.journalTotal }} 条</span>
      <el-pagination
        :current-page="page.journalPage"
        :page-size="page.pageSize"
        background
        layout="prev, pager, next"
        :total="page.journalTotal"
        @current-change="page.setJournalPage"
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
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import {
  accountCodeLabel,
  formatCny,
  formatDate,
  formatOriginal,
  journalTypeLabel
} from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.journals,
  pageSize: () => props.page.pageSize
});
const journalReversalHelp = [
  '已发布流水不能直接修改或删除，系统会保留原始记录，方便以后核对。',
  '冲销会新增一笔金额相反的流水，抵消原流水对余额和损益的影响；原流水随后显示“已冲销”。',
  '例如原流水是 +1000 元，冲销流水就是 -1000 元，两笔合计净影响为 0 元。',
  '冲销不是删除，也不一定代表退款。如果原记录有误，请冲销后再按正确业务证据重新记账。'
];
</script>
