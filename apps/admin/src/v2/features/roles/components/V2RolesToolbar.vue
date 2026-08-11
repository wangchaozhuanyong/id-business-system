<template>
  <section class="v2-roles-command-panel" aria-label="角色权限筛选">
    <V2SectionHeading class="v2-roles-command-panel__heading" title="角色筛选">
      <template #actions>
        <span>{{ page.activeFilterCount ? '已启用关键字筛选' : '全部角色' }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-roles-filter-grid">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="角色名称、编码或说明"
        aria-label="搜索角色"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <div class="v2-roles-filter-grid__actions">
        <AppButton variant="primary" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
        <AppButton :disabled="!page.activeFilterCount" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
          重置
        </AppButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useRolesPage } from '../useRolesPage';

type RolesPage = UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;

defineProps<{ page: RolesPage }>();
</script>
