<template>
  <section class="v2-options-command-panel" aria-label="选项筛选工具">
    <V2SectionHeading
      class="v2-options-command-panel__heading"
      :title="`${page.selectedTypeDefinition?.label ?? '选项'}筛选`"
      help="按名称、备注和启用状态缩小当前分类的数据范围。"
    >
      <template #actions>
        <span class="v2-options-command-panel__result">当前共 {{ page.total }} 条</span>
      </template>
    </V2SectionHeading>

    <div class="v2-options-filter-grid">
      <el-input
        v-model="page.query.keyword"
        clearable
        :disabled="page.loading"
        placeholder="搜索选项名称或备注"
        aria-label="搜索选项"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.status"
        clearable
        :disabled="page.loading"
        placeholder="全部状态"
        aria-label="筛选状态"
        @change="page.handleFilterChange"
      >
        <el-option label="启用" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <AppButton variant="primary" :disabled="page.loading" @click="page.handleSearch">
        <el-icon><Search /></el-icon>
        查询选项
      </AppButton>
      <AppButton
        v-if="page.activeFilterCount"
        variant="ghost"
        :disabled="page.loading"
        @click="page.resetFilters"
      >
        重置
      </AppButton>
    </div>

    <footer class="v2-options-command-panel__footer">
      <p>
        <el-icon><Lock /></el-icon>
        系统固定选项不可编辑或删除，其他操作仍按现有权限与审计规则执行。
      </p>
      <span v-if="page.activeFilterCount">已启用 {{ page.activeFilterCount }} 个筛选条件</span>
      <span v-else>当前显示全部{{ page.selectedTypeDefinition?.label ?? '选项' }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Lock, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useOptionsPage } from '../useOptionsPage';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

defineProps<{
  page: OptionsPage;
}>();
</script>
