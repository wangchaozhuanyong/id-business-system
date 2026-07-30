<template>
  <span class="v2-sensitive-cell">
    <strong>{{ maskedValue || '—' }}</strong>
    <AppButton
      v-if="hasValue && canReveal"
      icon-only
      size="small"
      variant="ghost"
      :title="revealTitle"
      @click="$emit('reveal')"
    >
      <el-icon><View /></el-icon>
    </AppButton>
  </span>
</template>

<script setup lang="ts">
import { View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';

defineProps<{
  maskedValue: string | null;
  hasValue: boolean;
  canReveal: boolean;
  revealTitle: string;
}>();

defineEmits<{
  reveal: [];
}>();
</script>
