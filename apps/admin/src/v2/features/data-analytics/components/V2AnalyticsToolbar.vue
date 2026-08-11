<template>
  <section class="v2-analytics-command-panel" aria-label="经营分析筛选">
    <V2SectionHeading
      title="分析筛选"
      help="筛选按业务日期和财务维度重新核算全部分析分区，不会修改原始流水。"
    >
      <template #actions>
        <span>{{ page.activeFilterLabel }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-analytics-filter-grid">
      <el-date-picker
        v-model="page.filters.dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        aria-label="筛选业务日期"
      />
      <el-select
        v-model="page.filters.currency"
        clearable
        placeholder="全部币种"
        aria-label="筛选币种"
      >
        <el-option v-for="item in page.currencies" :key="item" :label="item" :value="item" />
      </el-select>
      <el-select
        v-model="page.filters.supplierOptionId"
        clearable
        placeholder="全部供应商"
        aria-label="筛选供应商"
      >
        <el-option
          v-for="item in page.supplierOptions"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select
        v-model="page.filters.journalType"
        clearable
        placeholder="全部业务类型"
        aria-label="筛选业务类型"
      >
        <el-option
          v-for="item in page.journalTypeOptions"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select
        v-model="page.filters.financeAccountId"
        clearable
        placeholder="全部资金账户"
        aria-label="筛选资金账户"
      >
        <el-option
          v-for="item in page.accounts"
          :key="item.id"
          :label="`${item.name} · ${item.currency}`"
          :value="item.id"
        />
      </el-select>
      <el-select
        v-model="page.filters.settlementPlatformOptionId"
        clearable
        filterable
        placeholder="全部结算平台"
        aria-label="筛选结算平台"
      >
        <el-option
          v-for="item in page.settlementPlatformOptions"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>
      <div class="v2-analytics-filter-grid__actions">
        <AppButton variant="primary" @click="page.applyFilters">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
        <AppButton variant="ghost" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
          重置
        </AppButton>
        <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
      </div>
    </div>

    <footer>
      <p>
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        全部金额继续按后端 Decimal 字符串与已锁定汇率展示；筛选只更新报表口径。
      </p>
      <span>本位币 CNY · {{ page.analysisRangeLabel }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useDataAnalyticsPage } from '../useDataAnalyticsPage';

type DataAnalyticsPage = UnwrapNestedRefs<ReturnType<typeof useDataAnalyticsPage>>;

defineProps<{ page: DataAnalyticsPage }>();
</script>
