<template>
  <section class="v2-finance-expenses-command-panel" aria-label="收支记录筛选">
    <V2SectionHeading
      :title="page.cashbookView === 'inflows' ? '收入筛选' : '开支筛选'"
      help="筛选只改变当前记录视图，不会修改已经入账或冲销的财务数据。"
    >
      <template #actions>
        <span>{{ page.filters.currency ? `已筛选 ${page.filters.currency}` : '当前未筛选' }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-finance-expenses-filter-grid">
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
      <AppButton
        variant="ghost"
        :disabled="!page.filters.currency && !page.filters.inflowNature"
        @click="page.resetFilters"
      >
        <el-icon><RefreshLeft /></el-icon>
        清除筛选
      </AppButton>
    </div>

    <footer>
      <p>
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        金额沿用后端 Decimal 字符串展示；经营收入计入利润，股东投入和借入资金不计入利润。
      </p>
      <span>
        当前显示
        {{ page.cashbookView === 'inflows' ? page.inflows.length : page.expenses.length }} 条
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled, RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
