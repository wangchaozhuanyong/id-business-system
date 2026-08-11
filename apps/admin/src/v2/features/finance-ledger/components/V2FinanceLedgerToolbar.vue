<template>
  <section class="v2-finance-ledger-command-panel" aria-label="钱包账户筛选">
    <V2SectionHeading
      :title="`${activeLabel}筛选`"
      help="筛选只改变当前财务快照，不会修改任何账务记录。"
    >
      <template #actions>
        <span>{{ filterSummary }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-finance-ledger-filter-grid">
      <el-select
        v-model="page.filters.currency"
        clearable
        placeholder="全部币种"
        aria-label="筛选币种"
        @change="page.applyFilters"
      >
        <el-option label="CNY" value="CNY" />
        <el-option label="MYR" value="MYR" />
        <el-option label="USD" value="USD" />
        <el-option label="USDT" value="USDT" />
      </el-select>
      <el-input
        v-if="page.activeTab === 'journals'"
        v-model="page.filters.periodMonth"
        placeholder="月份 YYYY-MM"
        maxlength="7"
        aria-label="筛选财务月份"
        @keyup.enter="page.applyFilters"
      />
      <AppButton v-if="page.activeTab === 'journals'" variant="soft" @click="page.applyFilters">
        <el-icon><Search /></el-icon>
        查询流水
      </AppButton>
      <AppButton variant="ghost" :disabled="activeFilterCount === 0" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        清除筛选
      </AppButton>
    </div>

    <footer>
      <p>
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        币种筛选会同时更新账户、钱包和流水；月份条件仅用于不可变流水。
      </p>
      <span>当前显示 {{ activeCount }} 条</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
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
