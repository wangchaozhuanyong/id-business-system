<template>
  <section ref="listRef" class="v2-finance-ledger-list v2-records-list" :style="listFrameStyle">
    <header class="v2-finance-ledger-list__header">
      <V2SectionHeading
        title="关账月份列表"
        help="历史回填与月度关账沿用现有审核和权限边界，已关账月份可按原流程重新打开。"
      >
        <template #actions>
          <V2TableColumnSettings inline :schema="v2TableSchemas.financeLedger.periods" />
          <span>本页 {{ page.periods.length }} 条</span>
        </template>
      </V2SectionHeading>
    </header>

    <section class="v2-finance-history" aria-label="财务历史状态">
      <article>
        <div>
          <span>财务启用时间</span>
          <strong>{{ formatDate(page.settings?.enabledAt) }}</strong>
        </div>
        <el-tag
          :type="page.settings?.historyStatus === 'completed' ? 'success' : 'warning'"
          effect="plain"
        >
          {{ historyStatusLabel(page.settings?.historyStatus) }}
        </el-tag>
      </article>
      <p>{{ page.settings?.historyNote || '尚未填写历史状态说明' }}</p>
      <div v-if="page.canManage">
        <AppButton
          v-if="page.settings?.historyStatus !== 'completed'"
          variant="soft"
          :loading="page.historyPreviewLoading"
          @click="page.openHistoryBackfillPreview"
        >
          预览历史回填
        </AppButton>
        <AppButton
          v-if="page.settings?.historyStatus === 'incomplete'"
          variant="ghost"
          :loading="page.historyConfirmationLoading"
          @click="page.openHistoryConfirmation"
        >
          确认期初与旧开支
        </AppButton>
        <AppButton
          v-if="page.settings?.historyStatus === 'completed'"
          variant="ghost"
          @click="page.openHistoryReopen"
        >
          重新核对历史
        </AppButton>
      </div>
    </section>

    <V2Table
      :schema="v2TableSchemas.financeLedger.periods"
      :show-column-settings="false"
      class="v2-records-table"
      :data="page.periods"
      scrollbar-always-on
      show-overflow-tooltip
    >
      <template #empty>
        <FinanceEmpty title="暂无关账月份" description="未关账月份默认保持开放" />
      </template>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.periods.columns[0]">
        <template #default="{ row }"
          ><strong>{{ row.month }}</strong></template
        >
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.periods.columns[1]">
        <template #default="{ row }">
          <el-tag :type="periodStatusType(row.status)" effect="plain">
            {{ periodStatusLabel(row.status) }}
          </el-tag>
        </template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.periods.columns[2]">
        <template #default="{ row }">{{ formatDate(row.closedAt) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.periods.columns[3]">
        <template #default="{ row }">{{ formatDate(row.reopenedAt) }}</template>
      </V2TableColumn>
      <V2TableColumn :definition="v2TableSchemas.financeLedger.periods.columns[4]">
        <template #default="{ row }">{{ row.reopenReason || '—' }}</template>
      </V2TableColumn>
      <V2TableActionColumn
        v-if="page.canClose"
        :definition="v2TableSchemas.financeLedger.periods.columns[5]"
      >
        <template #default="{ row }">
          <AppButton
            v-if="row.status === 'closed'"
            size="small"
            variant="ghost"
            @click="page.openPeriod('reopen', row)"
          >
            重新打开
          </AppButton>
          <span v-else>—</span>
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
  formatDate,
  historyStatusLabel,
  periodStatusLabel,
  periodStatusType
} from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
import FinanceEmpty from './FinanceEmpty';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.periods,
  pageSize: () => props.page.pageSize
});
</script>
