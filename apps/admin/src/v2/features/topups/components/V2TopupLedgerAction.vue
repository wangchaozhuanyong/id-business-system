<template>
  <AppButton
    size="small"
    variant="ghost"
    title="查看该 ID 的完整余额变动"
    @click="page.openAccountRecords(item, 'ledger')"
  >
    <el-icon><DataAnalysis /></el-icon>
    流水 {{ item.balanceChangeCount }}
  </AppButton>
</template>

<script setup lang="ts">
import { DataAnalysis } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; item: V2TopupWorkbenchItem }>();
</script>
