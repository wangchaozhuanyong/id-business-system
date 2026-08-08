<template>
  <footer class="v2-order-entry-actions">
    <div>
      <span>订单状态</span>
      <strong>待处理</strong>
    </div>
    <span v-if="disabledReason" class="v2-submit-disabled-reason" role="status">
      {{ disabledReason }}
    </span>
    <AppButton
      variant="primary"
      :loading="submitting"
      :disabled="Boolean(disabledReason)"
      :aria-label="disabledReason ? `创建并扣减余额：${disabledReason}` : '创建并扣减余额'"
      @click="$emit('submit')"
    >
      <el-icon><CircleCheck /></el-icon>
      创建并扣减余额
    </AppButton>
  </footer>
</template>

<script setup lang="ts">
import { CircleCheck } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';

defineProps<{
  submitting: boolean;
  disabledReason: string;
}>();

defineEmits<{
  submit: [];
}>();
</script>
