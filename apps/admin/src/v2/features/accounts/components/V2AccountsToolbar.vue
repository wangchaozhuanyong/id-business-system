<template>
  <V2ListToolbar
    :show-filters="!showingLossRecords"
    class="v2-account-command-panel"
    aria-label="ID 管理工具"
    :title="showingLossRecords ? 'ID 分类' : 'ID 分类与筛选'"
    :help="[
      showingLossRecords
        ? '报损记录保留冻结快照、财务冲回和恢复审计。'
        : '先切换生命周期，再使用搜索和筛选缩小 ID 资料范围。',
      !showingLossRecords ? ' 敏感资料默认脱敏，查看、复制和导出都会写入审计日志。 ' : ''
    ]"
  >
    <template #navigation
      ><V2AccountLifecycleTabs
        :model-value="activeLifecycle"
        :show-reported="page.canViewLosses"
        @select="emit('select', $event)"
    /></template>
    <template v-if="!showingLossRecords">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="搜索 ID 账号、手机号或供应商"
        aria-label="搜索 ID 资料"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.countryOptionId"
        clearable
        placeholder="全部国家"
        aria-label="筛选国家"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.countryOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>
      <V2FilterDisclosure
        :label="page.activeFilterCount ? `更多筛选 · ${page.activeFilterCount}` : '更多筛选'"
      >
        <el-select
          v-model="page.query.statusOptionId"
          clearable
          placeholder="全部 ID 状态"
          aria-label="筛选 ID 状态"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.statusOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.supplierOptionId"
          clearable
          placeholder="全部供应商"
          aria-label="筛选 ID 供应商"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.supplierOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
      </V2FilterDisclosure>
    </template>
    <template #actions
      ><template v-if="!showingLossRecords"
        ><AppButton variant="primary" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          查询 ID
        </AppButton>
        <AppButton v-if="page.activeFilterCount" variant="ghost" @click="page.resetFilters">
          重置
        </AppButton></template
      ></template
    >
    <template #meta>
      <span class="v2-account-command-panel__result">
        {{ showingLossRecords ? '报损档案' : `当前共 ${page.total} 条` }}
      </span>

      <template v-if="!showingLossRecords"
        ><span v-if="page.activeFilterCount">已启用 {{ page.activeFilterCount }} 个筛选条件</span>
        <span v-else>当前分类：{{ page.lifecycleLabel }}</span></template
      ></template
    >
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import type { UnwrapNestedRefs } from 'vue';
import { Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2AccountLifecycleTabs from './V2AccountLifecycleTabs.vue';
import type { useAccountsPage } from '../useAccountsPage';
import type { V2AccountLifecycle } from '../contracts';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

defineProps<{
  page: AccountsPage;
  activeLifecycle: V2AccountLifecycle;
  showingLossRecords: boolean;
}>();

const emit = defineEmits<{
  select: [value: V2AccountLifecycle];
}>();
</script>
