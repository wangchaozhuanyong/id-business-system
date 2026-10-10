<template>
  <el-input
    v-bind="$attrs"
    v-model="value"
    class="recharge-sensitive-input"
    :class="{ 'is-masked': !visible && textMaskSupported }"
    :type="!visible && !textMaskSupported ? 'password' : 'text'"
    :autocomplete="textMaskSupported ? autocomplete : 'new-password'"
    :disabled="inputDisabled"
    autocapitalize="off"
    autocorrect="off"
    :spellcheck="false"
    data-1p-ignore="true"
    data-lpignore="true"
  >
    <template #suffix>
      <el-icon
        v-if="value && !inputDisabled"
        class="el-input__icon el-input__password"
        role="button"
        tabindex="0"
        :aria-label="visible ? '隐藏内容' : '显示内容'"
        :aria-pressed="visible"
        @mousedown.prevent
        @mouseup.prevent
        @click="visible = !visible"
        @keydown.enter.prevent="visible = !visible"
        @keydown.space.prevent="visible = !visible"
      >
        <View v-if="visible" />
        <Hide v-else />
      </el-icon>
    </template>
  </el-input>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useFormDisabled } from 'element-plus';
import { Hide, View } from '@element-plus/icons-vue';

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ disabled?: boolean; autocomplete?: string }>(), {
  disabled: undefined,
  autocomplete: 'off'
});
const value = defineModel<string>({ required: true });
const inputDisabled = useFormDisabled();
const visible = ref(false);
// These are one-off authorization/payment data, not credentials for this site.
// Chromium can mask text without treating the entire entry form as a login.
const textMaskSupported =
  typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc');
watch([value, inputDisabled], ([text, locked]) => {
  if (!text || locked) visible.value = false;
});
</script>

<style scoped>
.recharge-sensitive-input.is-masked :deep(input) {
  -webkit-text-security: disc;
}
</style>
