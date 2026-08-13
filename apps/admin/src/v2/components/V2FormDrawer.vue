<template>
  <el-drawer
    class="v2-form-drawer"
    :model-value="modelValue"
    :title="title"
    :size="size"
    destroy-on-close
    :close-on-click-modal="!confirmLoading"
    :close-on-press-escape="!confirmLoading"
    :show-close="!confirmLoading"
    :before-close="handleBeforeClose"
    @close="$emit('update:modelValue', false)"
  >
    <template #header>
      <div class="v2-form-drawer__heading">
        <span v-if="eyebrow" class="v2-form-drawer__eyebrow">{{ eyebrow }}</span>
        <h2>{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
    </template>
    <div class="v2-form-drawer__body">
      <slot />
    </div>
    <template #footer>
      <div class="v2-form-drawer__footer">
        <span v-if="confirmDisabledReason" class="v2-submit-disabled-reason" role="status">
          {{ confirmDisabledReason }}
        </span>
        <AppButton variant="ghost" :disabled="confirmLoading" @click="requestClose">
          取消
        </AppButton>
        <AppButton
          variant="primary"
          :disabled="confirmDisabled || Boolean(confirmDisabledReason)"
          :loading="confirmLoading"
          :aria-label="
            confirmDisabledReason ? `${confirmText}：${confirmDisabledReason}` : undefined
          "
          @click="$emit('confirm')"
        >
          {{ confirmText }}
        </AppButton>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    size?: string | number;
    eyebrow?: string;
    description?: string;
    confirmText?: string;
    confirmDisabled?: boolean;
    confirmDisabledReason?: string;
    confirmLoading?: boolean;
    dirty?: boolean;
  }>(),
  {
    size: 'min(520px, 92vw)',
    eyebrow: '',
    description: '',
    confirmText: '保存',
    confirmDisabled: false,
    confirmDisabledReason: '',
    confirmLoading: false,
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
    await ElMessageBox.confirm('当前表单有尚未保存的内容，确认放弃并关闭吗？', '放弃未保存内容', {
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
