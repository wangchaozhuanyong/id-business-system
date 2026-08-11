<template>
  <section class="v2-customer-command-panel" aria-label="客户筛选工具">
    <V2SectionHeading
      class="v2-customer-command-panel__heading"
      title="客户筛选"
      help="使用联系方式、来源、标签、历史业务和资料状态缩小客户范围。"
    >
      <template #actions>
        <span class="v2-customer-command-panel__result">当前共 {{ page.total }} 条</span>
      </template>
    </V2SectionHeading>

    <div class="v2-customer-filter-grid" aria-label="客户筛选">
      <el-input
        v-model="page.query.keyword"
        class="v2-customer-filter-grid__search"
        clearable
        placeholder="客户名称、手机、微信、QQ、WhatsApp"
        aria-label="搜索客户"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.sourceOptionId"
        clearable
        placeholder="全部来源"
        aria-label="筛选客户来源"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.sourceOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>
      <V2FilterDisclosure
        :label="page.activeFilterCount ? `更多筛选 · ${page.activeFilterCount}` : '更多筛选'"
      >
        <el-select
          v-model="page.query.tagOptionId"
          clearable
          placeholder="全部标签"
          aria-label="筛选客户标签"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.tagOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.serviceOptionId"
          clearable
          filterable
          placeholder="全部历史业务"
          aria-label="筛选历史开通业务"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.serviceOptions"
            :key="option.id"
            :label="page.selectorLabel(option)"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.recordStatus"
          clearable
          placeholder="全部状态"
          aria-label="筛选资料状态"
          @change="page.handleFilterChange"
        >
          <el-option label="启用" value="active" />
          <el-option label="停用" value="disabled" />
        </el-select>
      </V2FilterDisclosure>
      <AppButton variant="primary" @click="page.handleSearch">
        <el-icon><Search /></el-icon>
        查询客户
      </AppButton>
      <AppButton v-if="page.activeFilterCount" variant="ghost" @click="page.resetFilters">
        重置
      </AppButton>
    </div>

    <footer class="v2-customer-command-panel__footer">
      <p class="v2-records-security-note">
        <el-icon><Lock /></el-icon>
        手机号和 WhatsApp 默认脱敏，查看操作受权限与审核策略控制并保留审计。
      </p>
      <span v-if="page.activeFilterCount">已启用 {{ page.activeFilterCount }} 个筛选条件</span>
      <span v-else>当前显示全部客户</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Lock, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useCustomersPage } from '../useCustomersPage';

type CustomersPage = UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;

defineProps<{
  page: CustomersPage;
}>();
</script>
