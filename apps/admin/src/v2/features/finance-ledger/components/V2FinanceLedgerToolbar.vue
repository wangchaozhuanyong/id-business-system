<template>
  <V2ListToolbar
    class="v2-finance-ledger-command-panel"
    aria-label="钱包账户筛选"
    :title="`${activeLabel}筛选`"
    :help="[
      '筛选只改变当前财务快照，不会修改任何账务记录。',
      ' 币种筛选会同时更新账户、钱包和流水；月份条件仅用于不可变流水。 '
    ]"
  >
    <V2FinanceCurrencySelect
      v-model="page.filters.currency"
      clearable
      placeholder="全部币种"
      aria-label="筛选币种"
      @change="page.applyFilters"
    />
    <el-input
      v-if="page.activeTab === 'journals'"
      v-model="page.filters.periodMonth"
      placeholder="月份 YYYY-MM"
      maxlength="7"
      aria-label="筛选财务月份"
      @keyup.enter="page.applyFilters"
    />
    <template #actions
      ><AppButton v-if="page.activeTab === 'journals'" variant="soft" @click="page.applyFilters">
        <el-icon><Search /></el-icon>
        查询流水
      </AppButton>
      <AppButton variant="ghost" :disabled="activeFilterCount === 0" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        清除筛选
      </AppButton></template
    >
    <template #meta>
      <span>{{ filterSummary }}</span>

      <span>当前显示 {{ activeCount }} 条</span></template
    >
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const labels = {
  accounts: '资金账户',
  wallets: '供应商钱包',
  expenses: '经营开支',
  journals: '不可变流水',
  periods: '关账月份'
} as const;
const activeLabel = computed(() => labels[props.page.activeTab]);
const activeCount = computed(() => {
  if (props.page.activeTab === 'accounts') return props.page.accounts.length;
  if (props.page.activeTab === 'wallets') return props.page.wallets.length;
  if (props.page.activeTab === 'journals') return props.page.journals.length;
  if (props.page.activeTab === 'periods') return props.page.periods.length;
  return props.page.expenses.length;
});
const activeFilterCount = computed(
  () =>
    Number(Boolean(props.page.filters.currency)) + Number(Boolean(props.page.filters.periodMonth))
);
const filterSummary = computed(() =>
  activeFilterCount.value ? `已启用 ${activeFilterCount.value} 项筛选` : '当前未筛选'
);
</script>
