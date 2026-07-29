<template>
  <section
    class="v2-status-strip"
    :aria-label="ariaLabel"
    :style="{ '--v2-status-columns': String(items.length) }"
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :class="[`is-${item.tone ?? 'neutral'}`, { 'is-active': activeKey === item.key }]"
      :aria-pressed="activeKey === item.key"
      @click="$emit('select', item.key)"
    >
      <span>{{ item.label }}</span>
      <strong>{{ item.count }}</strong>
    </button>
  </section>
</template>

<script setup lang="ts">
export interface V2StatusStripItem {
  key: string;
  label: string;
  count: number;
  tone?: 'danger' | 'warning' | 'primary' | 'success' | 'neutral';
}

withDefaults(
  defineProps<{
    items: V2StatusStripItem[];
    activeKey?: string;
    ariaLabel?: string;
  }>(),
  {
    activeKey: '',
    ariaLabel: '状态分布'
  }
);

defineEmits<{
  select: [key: string];
}>();
</script>

<style scoped>
.v2-status-strip {
  display: grid;
  min-width: 0;
  min-height: 54px;
  grid-template-columns: repeat(var(--v2-status-columns), minmax(0, 1fr));
  border: 1px solid var(--v2-border);
  border-radius: 7px;
  background: var(--v2-surface);
}

.v2-status-strip button {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 10px 18px;
  border: 0;
  border-right: 1px solid var(--v2-border-soft);
  background: transparent;
  color: var(--v2-text-soft);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.v2-status-strip button:last-child {
  border-right: 0;
}

.v2-status-strip button::after {
  position: absolute;
  right: 14px;
  bottom: -1px;
  left: 14px;
  height: 2px;
  background: transparent;
  content: '';
}

.v2-status-strip button:hover {
  background: var(--v2-surface-hover);
}

.v2-status-strip button:focus-visible {
  z-index: 1;
  outline: none;
  box-shadow: inset var(--v2-focus);
}

.v2-status-strip strong {
  color: var(--v2-text);
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.v2-status-strip .is-danger strong {
  color: var(--v2-danger);
}

.v2-status-strip .is-warning strong {
  color: var(--el-color-warning);
}

.v2-status-strip .is-primary strong {
  color: var(--v2-accent);
}

.v2-status-strip .is-success strong {
  color: var(--v2-success);
}

.v2-status-strip button.is-active {
  background: var(--v2-surface-hover);
  color: var(--v2-text);
}

.v2-status-strip button.is-active::after {
  background: currentColor;
}

@media (max-width: 760px) {
  .v2-status-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .v2-status-strip button {
    min-height: 48px;
    padding-inline: 14px;
    border-bottom: 1px solid var(--v2-border-soft);
    white-space: normal;
  }

  .v2-status-strip button:nth-child(2n) {
    border-right: 0;
  }

  .v2-status-strip button:nth-last-child(-n + 2):nth-child(odd),
  .v2-status-strip button:last-child {
    border-bottom: 0;
  }

  .v2-status-strip button:last-child:nth-child(odd) {
    grid-column: 1 / -1;
    border-right: 0;
  }
}
</style>
