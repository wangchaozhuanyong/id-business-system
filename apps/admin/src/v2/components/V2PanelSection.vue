<template>
  <section class="v2-panel-section" :aria-labelledby="headingId">
    <V2SectionHeading
      :title="title"
      :title-id="headingId"
      :step="step"
      :help="help"
      level="h3"
      compact
    />
    <div class="v2-panel-section__content">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import V2SectionHeading from './V2SectionHeading.vue';

withDefaults(
  defineProps<{
    headingId: string;
    title: string;
    step?: string | number;
    help?: string | string[];
  }>(),
  {
    step: '',
    help: ''
  }
);
</script>

<style scoped>
.v2-panel-section {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding: 18px 0 20px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-panel-section:first-child {
  padding-top: 2px;
  border-top: 0;
}

.v2-panel-section:last-child {
  padding-bottom: 0;
}

.v2-panel-section__content {
  min-width: 0;
}

.v2-panel-section__content > :deep(dl),
.v2-panel-section__content > :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
</style>
