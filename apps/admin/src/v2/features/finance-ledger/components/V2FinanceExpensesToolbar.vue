<template>
  <section class="v2-finance-expenses-command-panel" aria-label="经营开支筛选">
    <V2SectionHeading
      title="开支筛选"
      help="筛选只改变当前开支记录视图，不会修改已经入账或冲销的财务数据。"
    >
      <template #actions>
        <span>{{ page.filters.currency ? `已筛选 ${page.filters.currency}` : '当前未筛选' }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-finance-expenses-filter-grid">
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
      <AppButton variant="ghost" :disabled="!page.filters.currency" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        清除筛选
      </AppButton>
    </div>

    <footer>
      <p>
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        金额沿用后端 Decimal 字符串展示；更正会生成冲销与新记录，不覆盖原始账务。
      </p>
      <span>当前显示 {{ page.expenses.length }} 条</span>
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
