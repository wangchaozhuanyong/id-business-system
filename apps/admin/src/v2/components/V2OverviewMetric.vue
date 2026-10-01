<template>
  <component
    :is="interactive ? 'button' : 'article'"
    class="v2-overview-metric"
    :type="interactive ? 'button' : undefined"
  >
    <span class="v2-overview-metric__label">{{ label }}</span>
    <strong
      class="v2-overview-metric__value"
      :class="{ 'is-danger': danger }"
      :title="String(value)"
      >{{ value }}</strong
    >
    <small class="v2-overview-metric__note">{{ note }}</small>
  </component>
</template>
<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    note: string;
    interactive?: boolean;
    danger?: boolean;
  }>(),
  { interactive: false, danger: false }
);
</script>
<style scoped>
.v2-overview-metric {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, max-content) minmax(48px, 1fr);
  align-items: center;
  gap: 3px 8px;
  margin: 0;
  padding: 8px 12px;
  border: 0;
  background: var(--v2-overview-surface);
  color: var(--v2-overview-text);
  font: inherit;
  text-align: left;
}
.v2-overview-metric__label,
.v2-overview-metric__value {
  min-width: 0;
  font-size: 15px;
  line-height: var(--v3-line-height-tight);
}
.v2-overview-metric__label {
  overflow-wrap: anywhere;
}
.v2-overview-metric__value {
  text-align: right;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v2-overview-metric__value.is-danger {
  color: var(--v2-danger);
}
.v2-overview-metric__note {
  grid-column: 1 / -1;
  color: var(--v2-overview-text-soft);
  font-size: 10px;
  line-height: var(--v3-line-height-body);
}
button.v2-overview-metric {
  cursor: pointer;
}
button.v2-overview-metric:hover {
  background: var(--v2-overview-control-hover);
}
button.v2-overview-metric:focus-visible {
  outline: 2px solid var(--v2-accent);
  outline-offset: -2px;
}
</style>
