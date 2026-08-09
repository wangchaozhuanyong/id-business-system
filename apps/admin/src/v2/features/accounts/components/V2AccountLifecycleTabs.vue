<template>
  <nav class="v2-account-lifecycle-tabs" aria-label="ID 快捷分类">
    <button
      v-for="option in visibleOptions"
      :key="option.value"
      type="button"
      :class="{ 'is-active': modelValue === option.value }"
      :aria-current="modelValue === option.value ? 'page' : undefined"
      @click="emit('select', option.value)"
    >
      {{ option.label }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { V2AccountLifecycle } from '../contracts';

const props = defineProps<{
  modelValue: V2AccountLifecycle;
  showReported: boolean;
}>();

const emit = defineEmits<{
  select: [value: V2AccountLifecycle];
}>();

const options: Array<{ value: V2AccountLifecycle; label: string }> = [
  { value: 'available', label: '可用 ID' },
  { value: 'disabled', label: '已停用' },
  { value: 'sold', label: '已售出' },
  { value: 'reported', label: '已报损' }
];

const visibleOptions = computed(() =>
  options.filter((option) => option.value !== 'reported' || props.showReported)
);
</script>
