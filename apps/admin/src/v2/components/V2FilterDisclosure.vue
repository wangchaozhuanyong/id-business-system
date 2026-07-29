<template>
  <details class="v2-filter-disclosure">
    <summary>
      <span>{{ label }}</span>
      <span class="v2-filter-disclosure__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="v2-filter-disclosure__panel">
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string;
  }>(),
  {
    label: '更多筛选'
  }
);
</script>
