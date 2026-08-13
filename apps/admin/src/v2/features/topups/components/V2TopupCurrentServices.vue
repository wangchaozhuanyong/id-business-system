<template>
  <div
    v-if="item.currentServices.length"
    class="v2-topup-service-tags"
    :title="item.currentServices.map(page.servicePath).join('、')"
  >
    <el-tag
      v-for="service in item.currentServices"
      :key="service.id"
      type="success"
      effect="plain"
      :title="page.servicePath(service)"
    >
      {{ service.name }}
    </el-tag>
  </div>
  <span v-else>—</span>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage; item: V2TopupWorkbenchItem }>();
</script>
