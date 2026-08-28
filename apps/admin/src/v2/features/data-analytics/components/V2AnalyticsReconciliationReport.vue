<template>
  <section class="v2-finance-reconciliation-grid v2-analytics-reconciliation">
    <section ref="listRef" class="v2-analytics-report-list v2-records-list" :style="listFrameStyle">
      <header class="v2-analytics-report-list__header">
        <V2SectionHeading
          title="盈亏与账务明细"
          help="追溯订单、礼品卡、ID、损失和经营开支对应的不可变财务流水。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.dataAnalytics.journals" />
            <span>本页 {{ journals.length }} 条</span>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.dataAnalytics.journals"
        :show-column-settings="false"
        class="v2-records-table"
        :data="journals"
        scrollbar-always-on
        show-overflow-tooltip
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>当前筛选范围没有财务流水</strong>
            <span>完成订单或记账后会自动出现在这里</span>
          </div>
        </template>
        <V2TableControlColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[0]">
          <template #default="{ row }">
            <div class="v2-finance-lines">
              <div v-for="line in row.lines" :key="line.id">
                <span>{{ accountCodeLabel(line.accountCode) }}</span>
                <strong>{{ directionLabel(line.direction) }}</strong>
                <span>{{ formatOriginal(line.amountOriginal, line.currency) }}</span>
                <span>{{ formatCny(line.amountCny) }}</span>
                <span>{{ line.memo || '—' }}</span>
              </div>
            </div>
          </template>
        </V2TableControlColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[1]">
          <template #default="{ row }"
            ><strong>{{ row.journalNo }}</strong></template
          >
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[2]">
          <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[3]">
          <template #default="{ row }">
            <el-tag effect="plain">{{ journalTypeLabel(row.journalType) }}</el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.dataAnalytics.journals.columns[4]"
          prop="summary"
        />
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[5]">
          <template #default="{ row }">{{ row.sourceReference || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dataAnalytics.journals.columns[6]">
          <template #default="{ row }">{{ formatCny(journalAmount(row)) }}</template>
        </V2TableColumn>
      </V2Table>
    </section>

    <section class="v2-finance-panel v2-analytics-reconciliation__issues">
      <header>
        <V2SectionHeading
          title="闭环对账"
          :help="
            overview.reconciliation.isComplete
              ? '当前筛选范围的关键凭证与财务流水已经闭环。'
              : '按严重级别列出缺失汇率、未回填历史、余额差异或来源流水缺失。'
          "
        >
          <template #actions>
            <el-tag
              :type="overview.reconciliation.isComplete ? 'success' : 'warning'"
              effect="plain"
            >
              {{
                overview.reconciliation.isComplete
                  ? '已闭环'
                  : `${overview.reconciliation.issueCount} 项待处理`
              }}
            </el-tag>
          </template>
        </V2SectionHeading>
      </header>
      <el-alert
        v-if="overview.reconciliation.hasMoreIssues"
        :title="`已完成全量检查；问题共 ${overview.reconciliation.issueCount} 项，当前展示前 ${overview.reconciliation.returnedIssueCount} 项。`"
        type="warning"
        :closable="false"
        show-icon
      />
      <div v-if="overview.reconciliation.issues.length" class="v2-finance-issues">
        <article
          v-for="issue in overview.reconciliation.issues"
          :key="`${issue.code}:${issue.sourceId ?? issue.message}`"
          :class="`is-${issue.severity}`"
        >
          <el-tag
            :type="
              issue.severity === 'error'
                ? 'danger'
                : issue.severity === 'warning'
                  ? 'warning'
                  : 'info'
            "
            effect="plain"
            size="small"
          >
            {{
              issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '提醒' : '信息'
            }}
          </el-tag>
          <div>
            <strong>{{ issue.message }}</strong>
            <span v-if="issue.amountCny">{{ formatCny(issue.amountCny) }}</span>
          </div>
        </article>
      </div>
      <el-empty v-else description="当前筛选范围没有对账问题" />
    </section>
  </section>
</template>

<script setup lang="ts">
import type {
  V2FinanceAccountCode,
  V2FinanceCurrency,
  V2FinanceJournal,
  V2FinanceJournalType,
  V2FinanceOverview
} from '@apple-business/shared';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';

const props = defineProps<{
  overview: V2FinanceOverview;
  journals: V2FinanceJournal[];
  formatCny: (value: string | null | undefined) => string;
  formatOriginal: (value: string, currency: V2FinanceCurrency) => string;
  formatDate: (value: string) => string;
  journalAmount: (journal: V2FinanceJournal) => string;
  journalTypeLabel: (value: V2FinanceJournalType) => string;
  accountCodeLabel: (value: V2FinanceAccountCode) => string;
  directionLabel: (value: 'debit' | 'credit') => string;
}>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.journals,
  pageSize: () => 10
});
</script>
