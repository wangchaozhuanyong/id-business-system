<template>
  <V2ListToolbar
    class="v2-finance-expenses-command-panel"
    aria-label="收支记录筛选"
    :title="page.cashbookView === 'inflows' ? '收入筛选' : '开支筛选'"
    :help="[
      '筛选只改变当前记录视图，不会修改已经入账或冲销的财务数据。',
      ' 金额沿用后端 Decimal 字符串展示；经营收入计入利润，股东投入和借入资金不计入利润。 '
    ]"
  >
    <el-select
      v-if="page.cashbookView === 'inflows'"
      v-model="page.filters.inflowNature"
      clearable
      placeholder="全部资金性质"
      aria-label="筛选资金性质"
      @change="page.applyFilters"
    >
      <el-option label="经营收入" value="operating_income" />
      <el-option label="股东投入" value="capital_contribution" />
      <el-option label="借入资金" value="borrowed_funds" />
    </el-select>
    <V2FinanceCurrencySelect
      v-model="page.filters.currency"
      clearable
      placeholder="全部币种"
      aria-label="筛选币种"
      @change="page.applyFilters"
    />
    <template #actions
      ><AppButton
        variant="ghost"
        :disabled="!page.filters.currency && !page.filters.inflowNature"
        @click="page.resetFilters"
      >
        <el-icon><RefreshLeft /></el-icon>
        清除筛选
      </AppButton></template
    >
    <template #meta>
      <span>{{ page.filters.currency ? `已筛选 ${page.filters.currency}` : '当前未筛选' }}</span>

      <span>
        当前显示
        {{ page.cashbookView === 'inflows' ? page.inflows.length : page.expenses.length }} 条
      </span></template
    >
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
