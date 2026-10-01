<template>
  <AppButton
    size="small"
    variant="ghost"
    :loading="copying"
    :disabled="disabled || copying"
    @click="copy"
  >
    复制
  </AppButton>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi } from './bank-recharge-api';
import { copyChatgptAccount } from './copy-chatgpt-account';

const props = defineProps<{ id: string; disabled?: boolean }>();
const emit = defineEmits<{ error: [message: string] }>();
const copying = ref(false);
async function copy() {
  if (copying.value || props.disabled) return;
  if (!navigator.clipboard?.writeText) {
    emit('error', '当前浏览器无法复制，请使用 HTTPS 或本机页面后重试');
    return;
  }
  copying.value = true;
  emit('error', '');
  try {
    await copyChatgptAccount(
      () => bankRechargeApi.copyAccount(props.id),
      (text) => navigator.clipboard.writeText(text)
    );
    ElMessage.success('账号资料已复制');
  } catch (error) {
    emit(
      'error',
      error instanceof DOMException
        ? '复制失败，请允许浏览器访问剪贴板后重试'
        : getApiErrorMessage(error)
    );
  } finally {
    copying.value = false;
  }
}
</script>
