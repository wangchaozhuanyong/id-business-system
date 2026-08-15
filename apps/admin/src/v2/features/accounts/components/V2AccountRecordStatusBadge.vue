<template>
  <button
    v-if="account.recordStatus === 'disabled'"
    type="button"
    class="v2-account-status-trigger"
    title="查看停用原因"
    aria-label="查看停用原因"
    @click="emit('view-reason')"
  >
    <el-tag class="v2-status-tag" type="info" effect="plain">停用</el-tag>
    <el-icon><InfoFilled /></el-icon>
  </button>
  <el-tag v-else class="v2-status-tag" type="success" effect="plain">启用</el-tag>
</template>

<script setup lang="ts">
import { InfoFilled } from '@element-plus/icons-vue';
import type { V2Account } from '../contracts';

defineProps<{ account: V2Account }>();

const emit = defineEmits<{
  'view-reason': [];
}>();
</script>
