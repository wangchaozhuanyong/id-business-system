<template>
  <AppButton
    v-if="page.canAdjustBalance && item.topupRecordCount > 0"
    icon-only
    size="small"
    variant="ghost"
    title="处理可标记被赎回或撤回的礼品卡"
    @click="page.openReversalDrawer(item)"
  >
    <el-icon><RefreshLeft /></el-icon>
  </AppButton>
</template>

<script setup lang="ts">
import { RefreshLeft } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; item: V2TopupWorkbenchItem }>();
</script>
