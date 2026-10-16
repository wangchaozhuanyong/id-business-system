<template>
  <V2ListToolbar class="v2-roles-command-panel" aria-label="角色权限筛选" title="角色筛选">
    <V2SearchInput
      v-model="page.query.keyword"
      draft-key="roles:V2RolesToolbar:page.query.keyword"
      clearable
      placeholder="角色名称、编码或说明"
      aria-label="搜索角色"
      @search="page.handleSearch"
    />
    <template #actions>
      <AppButton :disabled="!page.activeFilterCount" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        重置
      </AppButton></template
    >
    <template #meta>
      <span>{{ page.activeFilterCount ? '已启用关键字筛选' : '全部角色' }}</span>
    </template>
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2SearchInput from '@/v2/components/V2SearchInput.vue';
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useRolesPage } from '../useRolesPage';

type RolesPage = UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;

defineProps<{ page: RolesPage }>();
</script>
