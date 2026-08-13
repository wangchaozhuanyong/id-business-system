<template>
  <div class="v2-records-empty">
    <strong>暂无{{ label }}</strong>
    <span>当前筛选条件下没有符合条件的{{ label }}</span>
    <AppButton variant="ghost" @click="page.resetFilters">重置筛选</AppButton>
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; label: string }>();
</script>
