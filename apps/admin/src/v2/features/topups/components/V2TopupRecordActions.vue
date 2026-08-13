<template>
  <div class="v2-topup-record-links">
    <AppButton
      size="small"
      variant="ghost"
      title="查看该 ID 的完整加卡记录"
      @click="page.openAccountRecords(item, 'giftCards')"
    >
      <el-icon><Tickets /></el-icon>
      加卡 {{ item.topupRecordCount }}
    </AppButton>
    <V2TopupReversalAction :page="page" :item="item" />
  </div>
</template>

<script setup lang="ts">
import { Tickets } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2TopupReversalAction from './V2TopupReversalAction.vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; item: V2TopupWorkbenchItem }>();
</script>
