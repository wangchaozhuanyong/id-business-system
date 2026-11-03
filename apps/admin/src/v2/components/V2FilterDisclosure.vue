<template>
  <details class="v2-filter-disclosure" @toggle="handleToggle">
    <summary>
      <span>{{ label }}</span>
      <span class="v2-filter-disclosure__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="v2-filter-disclosure__panel">
      <slot v-if="contentMounted" />
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const contentMounted = ref(false);
function handleToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) contentMounted.value = true;
}

withDefaults(
  defineProps<{
    label?: string;
  }>(),
  {
    label: '更多筛选'
  }
);
</script>
