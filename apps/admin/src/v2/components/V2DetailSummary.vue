<template>
  <section
    class="v2-detail-summary"
    :class="{ 'v2-detail-summary--identity-only': !metrics.length }"
    :aria-labelledby="headingId"
  >
    <header class="v2-detail-summary__identity">
      <span>{{ eyebrow }}</span>
      <h3 :id="headingId">{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
    </header>
    <dl v-if="metrics.length" class="v2-detail-summary__metrics">
      <div v-for="metric in metrics" :key="metric.label">
        <dt>{{ metric.label }}</dt>
        <dd :class="metric.tone ? `is-${metric.tone}` : undefined">{{ metric.value }}</dd>
      </div>
    </dl>
    <dl v-if="facts.length" class="v2-detail-summary__facts">
      <div v-for="fact in facts" :key="fact.label">
        <dt>{{ fact.label }}</dt>
        <dd>{{ fact.value || '—' }}</dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
export interface V2DetailSummaryItem {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'warning';
}

withDefaults(
  defineProps<{
    headingId: string;
    eyebrow: string;
    title: string;
    description?: string;
    metrics?: V2DetailSummaryItem[];
    facts?: V2DetailSummaryItem[];
  }>(),
  {
    description: '',
    metrics: () => [],
    facts: () => []
  }
);
</script>

<style scoped>
.v2-detail-summary {
  display: grid;
  min-width: 0;
  overflow: hidden;
  grid-template-columns: minmax(0, 1.25fr) minmax(220px, 0.75fr);
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface-muted);
}

.v2-detail-summary--identity-only {
  grid-template-columns: minmax(0, 1fr);
}

.v2-detail-summary__identity {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 3px;
  padding: 17px 18px;
}

.v2-detail-summary__identity span,
.v2-detail-summary__identity p,
.v2-detail-summary dt {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.5;
}

.v2-detail-summary__identity h3 {
  margin: 0;
  color: var(--v2-text);
  overflow-wrap: anywhere;
  font-size: 18px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 1.35;
}

.v2-detail-summary__metrics {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  border-left: 1px solid var(--v2-border-soft);
}

.v2-detail-summary__metrics > div {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 3px;
  padding: 14px 16px;
  border-left: 1px solid var(--v2-border-soft);
}

.v2-detail-summary__metrics > div:first-child {
  border-left: 0;
}

.v2-detail-summary__metrics > div:only-child {
  grid-column: 1 / -1;
}

.v2-detail-summary__metrics dd,
.v2-detail-summary__facts dd {
  margin: 0;
  color: var(--v2-text);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  font-weight: var(--v3-font-weight-bold);
}

.v2-detail-summary__metrics dd {
  font-size: 18px;
  line-height: 1.3;
}

.v2-detail-summary__metrics dd.is-positive {
  color: var(--v2-success);
}

.v2-detail-summary__metrics dd.is-negative {
  color: var(--v2-danger);
}

.v2-detail-summary__metrics dd.is-warning {
  color: var(--v3-warning);
}

.v2-detail-summary__facts {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 13px 18px 15px;
  gap: 12px 18px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-detail-summary__facts > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-detail-summary__facts dd {
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 680px) {
  .v2-detail-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-detail-summary__metrics {
    border-top: 1px solid var(--v2-border-soft);
    border-left: 0;
  }

  .v2-detail-summary__identity,
  .v2-detail-summary__metrics > div {
    padding: 13px 14px;
  }

  .v2-detail-summary__facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 12px 14px 14px;
  }
}
</style>
