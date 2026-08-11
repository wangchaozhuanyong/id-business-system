<template>
  <section class="v2-activation-command-panel" aria-label="开通记录筛选工具">
    <V2SectionHeading
      class="v2-activation-command-panel__heading"
      title="开通筛选"
      help="使用订单、客户、业务、ID 账号、到期状态和到期日期缩小记录范围。"
    >
      <template #actions>
        <span class="v2-activation-command-panel__result">当前共 {{ page.total }} 条</span>
      </template>
    </V2SectionHeading>

    <div class="v2-activation-filter-grid" aria-label="开通记录筛选">
      <el-input
        v-model="page.query.keyword"
        class="v2-activation-filter-grid__search"
        clearable
        placeholder="订单、客户、业务、ID账号"
        aria-label="搜索开通记录"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.dueStatus"
        clearable
        placeholder="全部到期状态"
        aria-label="筛选到期状态"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.dueStatusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <V2FilterDisclosure :label="page.dueRange.length ? '到期日期 · 已设置' : '到期日期'">
        <el-date-picker
          v-model="page.dueRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="到期开始"
          end-placeholder="到期结束"
          aria-label="筛选到期日期"
          @change="page.handleFilterChange"
        />
      </V2FilterDisclosure>
      <AppButton variant="primary" @click="page.handleSearch">
        <el-icon><Search /></el-icon>
        查询记录
      </AppButton>
      <AppButton v-if="page.activeFilterCount" variant="ghost" @click="page.resetFilters">
        重置
      </AppButton>
    </div>

    <footer class="v2-activation-command-panel__footer">
      <p>
        <el-icon><Timer /></el-icon>
        到期状态根据当前时间动态评估，刷新后会显示最新结果。
      </p>
      <span v-if="page.activeFilterCount">已启用 {{ page.activeFilterCount }} 个筛选条件</span>
      <span v-else>当前显示全部开通记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Search, Timer } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useActivationsPage } from '../useActivationsPage';

type ActivationsPage = UnwrapNestedRefs<ReturnType<typeof useActivationsPage>>;

defineProps<{
  page: ActivationsPage;
}>();
</script>
