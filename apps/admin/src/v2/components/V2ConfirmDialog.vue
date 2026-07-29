<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(420px, 92vw)"
    align-center
    @close="$emit('update:modelValue', false)"
  >
    <slot>
      <p class="v2-confirm-dialog__message">{{ message }}</p>
    </slot>
    <template #footer>
      <div class="v2-confirm-dialog__footer">
        <AppButton variant="ghost" @click="$emit('update:modelValue', false)">取消</AppButton>
        <AppButton
          :variant="danger ? 'danger' : 'primary'"
          :loading="confirmLoading"
          :disabled="confirmDisabled"
          @click="$emit('confirm')"
        >
          {{ confirmText }}
        </AppButton>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    message: string;
    confirmText?: string;
    confirmLoading?: boolean;
    confirmDisabled?: boolean;
    danger?: boolean;
  }>(),
  {
    confirmText: '确认',
    confirmLoading: false,
    confirmDisabled: false,
    danger: false
  }
);

defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();
</script>
