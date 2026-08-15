<template>
  <el-tag
    class="v2-status-tag"
    :type="item.status.code === 'normal' ? 'success' : 'warning'"
    effect="plain"
  >
    {{ item.status.name }}
  </el-tag>
</template>

<script setup lang="ts">
import type { V2TopupWorkbenchItem } from '../contracts';

defineProps<{ item: V2TopupWorkbenchItem }>();
</script>
