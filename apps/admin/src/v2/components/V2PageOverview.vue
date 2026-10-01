<template>
  <section class="v2-page-overview">
    <div class="v2-page-overview__identity">
      <slot name="identity" />
      <div class="v2-page-overview__intro">
        <V2SectionHeading :title="title" :help="help" placement="bottom" />
        <div v-if="$slots.meta" class="v2-page-overview__meta"><slot name="meta" /></div>
      </div>
    </div>
    <div
      class="v2-page-overview__metrics"
      :style="{ '--v2-overview-columns': columns }"
      :aria-label="metricsLabel"
    >
      <slot name="metrics" />
    </div>
    <div v-if="$slots.actions" class="v2-page-overview__actions"><slot name="actions" /></div>
  </section>
</template>

<script setup lang="ts">
import V2SectionHeading from './V2SectionHeading.vue';
withDefaults(
  defineProps<{
    title: string;
    help?: string | string[];
    metricsLabel?: string;
    columns?: number;
  }>(),
  { help: '', metricsLabel: '当前指标', columns: 4 }
);
</script>

<style scoped>
.v2-page-overview {
  container: v2-overview / inline-size;
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--v2-layout-panel-gap);
  padding: var(--v2-layout-panel-padding);
  border: 1px solid var(--v2-overview-border);
  border-radius: var(--v3-radius);
  background: var(--v2-overview-bg);
  color: var(--v2-overview-text);
  box-shadow: var(--v2-overview-shadow);
}
.v2-page-overview__identity {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: var(--v2-layout-control-gap);
}
.v2-page-overview__intro {
  min-width: 0;
}
.v2-page-overview__intro :deep(.v2-section-heading__title) {
  color: var(--v2-overview-text);
}
.v2-page-overview__meta {
  margin-top: 4px;
  color: var(--v2-overview-text-soft);
  font-size: 12px;
}
.v2-page-overview__metrics {
  display: grid;
  min-width: 0;
  flex: 1 1 560px;
  grid-template-columns: repeat(var(--v2-overview-columns), minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--v2-overview-divider);
  border-radius: var(--v3-radius-sm);
  background: var(--v2-overview-divider);
}
.v2-page-overview__actions {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--v2-layout-control-gap);
}
.v2-page-overview__actions :deep(> span) {
  color: var(--v2-overview-text-soft);
  font-size: 12px;
}
.v2-page-overview__actions :deep(.app-button--ghost.el-button) {
  --el-button-text-color: var(--v2-overview-text);
  --el-button-border-color: var(--v2-overview-control-border);
  --el-button-hover-text-color: var(--v2-overview-text);
  --el-button-hover-bg-color: var(--v2-overview-control-hover);
  --el-button-hover-border-color: var(--v2-overview-control-hover-border);
  --el-button-active-text-color: var(--v2-overview-text);
  --el-button-active-bg-color: var(--v2-overview-control-active);
  --el-button-active-border-color: var(--v2-overview-control-hover-border);
}
@container v2-overview (max-width: 640px) {
  .v2-page-overview__metrics {
    flex-basis: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .v2-page-overview__actions {
    width: 100%;
  }
}
</style>
