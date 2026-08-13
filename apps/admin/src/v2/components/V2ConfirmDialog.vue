<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="width"
    align-center
    :close-on-click-modal="!confirmLoading"
    :close-on-press-escape="!confirmLoading"
    :show-close="!confirmLoading"
    :before-close="handleBeforeClose"
    @close="$emit('update:modelValue', false)"
  >
    <slot>
      <p class="v2-confirm-dialog__message">{{ message }}</p>
    </slot>
    <template #footer>
      <div class="v2-confirm-dialog__footer">
        <span v-if="confirmDisabledReason" class="v2-submit-disabled-reason" role="status">
          {{ confirmDisabledReason }}
        </span>
        <AppButton variant="ghost" :disabled="confirmLoading" @click="requestClose">
          {{ cancelText }}
        </AppButton>
        <AppButton
          v-if="confirmVisible"
          :variant="danger ? 'danger' : 'primary'"
          :loading="confirmLoading"
          :disabled="confirmDisabled || Boolean(confirmDisabledReason)"
          :aria-label="
            confirmDisabledReason ? `${confirmText}：${confirmDisabledReason}` : undefined
          "
          @click="$emit('confirm')"
        >
          {{ confirmText }}
        </AppButton>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    message: string;
    width?: string;
    cancelText?: string;
    confirmText?: string;
    confirmVisible?: boolean;
    confirmLoading?: boolean;
    confirmDisabled?: boolean;
    confirmDisabledReason?: string;
    danger?: boolean;
    dirty?: boolean;
  }>(),
  {
    width: 'min(420px, 92vw)',
    cancelText: '取消',
    confirmText: '确认',
    confirmVisible: true,
    confirmLoading: false,
    confirmDisabled: false,
    confirmDisabledReason: '',
    danger: false,
    dirty: false
  }
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();

async function handleBeforeClose(done: () => void) {
  if (props.confirmLoading) return;
  if (!props.dirty) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('当前内容尚未提交，确认放弃并关闭吗？', '放弃未提交内容', {
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '继续填写',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续填写。
  }
}

function requestClose() {
  void handleBeforeClose(() => emit('update:modelValue', false));
}
</script>
