<template>
  <AppButton
    v-if="page.canTopup"
    size="small"
    variant="primary"
    :title="item.saleState === 'sold' ? '核对销售归属后加卡' : '礼品卡入账'"
    @click="page.openCreditDrawer(item)"
  >
    <el-icon><Plus /></el-icon>
    加卡
  </AppButton>
  <span v-else>—</span>
</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; item: V2TopupWorkbenchItem }>();
</script>
