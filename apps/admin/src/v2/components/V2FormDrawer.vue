<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    :size="size"
    destroy-on-close
    @close="$emit('update:modelValue', false)"
  >
    <div class="v2-form-drawer__body">
      <slot />
    </div>
    <template #footer>
      <div class="v2-form-drawer__footer">
        <AppButton variant="ghost" @click="$emit('update:modelValue', false)">取消</AppButton>
        <AppButton
          variant="primary"
          :disabled="confirmDisabled"
          :loading="confirmLoading"
          @click="$emit('confirm')"
        >
          {{ confirmText }}
        </AppButton>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    size?: string | number;
    confirmText?: string;
    confirmDisabled?: boolean;
    confirmLoading?: boolean;
  }>(),
  {
    size: 'min(520px, 92vw)',
    confirmText: '保存',
    confirmDisabled: false,
    confirmLoading: false
  }
);

defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();
</script>
