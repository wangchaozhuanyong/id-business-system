<template>
  <el-button
    v-bind="buttonAttrs"
    class="app-button"
    :class="[`app-button--${variant}`, { 'app-button--icon': iconOnly }]"
    :disabled="disabled"
    :loading="loading"
    @click="$emit('click', $event)"
  >
    <slot />
  </el-button>
</template>

<script setup lang="ts">
import { computed, useAttrs } from 'vue';

defineOptions({
  inheritAttrs: false
});

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'soft' | 'danger' | 'success' | 'ghost';
    loading?: boolean;
    disabled?: boolean;
    iconOnly?: boolean;
  }>(),
  {
    variant: 'default',
    loading: false,
    disabled: false,
    iconOnly: false
  }
);

defineEmits<{
  click: [event: MouseEvent];
}>();

const attrs = useAttrs();
const buttonAttrs = computed(() => {
  const normalizedAttrs = { ...attrs };
  const ariaLabel = normalizedAttrs['aria-label'];
  const title = normalizedAttrs.title;

  if (props.iconOnly) {
    if (typeof ariaLabel !== 'string' && typeof title === 'string' && title.trim()) {
      normalizedAttrs['aria-label'] = title;
    }

    if (typeof title !== 'string' && typeof ariaLabel === 'string' && ariaLabel.trim()) {
      normalizedAttrs.title = ariaLabel;
    }
  }

  if (props.loading && normalizedAttrs['aria-busy'] == null) {
    normalizedAttrs['aria-busy'] = 'true';
  }

  return normalizedAttrs;
});
</script>
