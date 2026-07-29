<template>
  <div
    class="v2-content-skeleton"
    :class="`v2-content-skeleton--${kind}`"
    :data-v2-skeleton="kind"
    aria-hidden="true"
  >
    <template v-if="kind === 'table'">
      <div class="v2-content-skeleton__table">
        <div class="v2-content-skeleton__table-meta">
          <span class="v2-content-skeleton__bone is-medium" />
          <span class="v2-content-skeleton__bone is-short" />
        </div>
        <div class="v2-content-skeleton__table-head">
          <span v-for="index in 7" :key="`head-${index}`" class="v2-content-skeleton__bone" />
        </div>
        <div v-for="row in 7" :key="`row-${row}`" class="v2-content-skeleton__table-row">
          <span
            v-for="column in 7"
            :key="`cell-${row}-${column}`"
            class="v2-content-skeleton__bone"
          />
        </div>
        <div class="v2-content-skeleton__table-footer">
          <span class="v2-content-skeleton__bone is-short" />
          <span class="v2-content-skeleton__bone is-long" />
        </div>
      </div>
    </template>

    <template v-else-if="kind === 'form'">
      <div class="v2-content-skeleton__form">
        <div class="v2-content-skeleton__form-main">
          <span class="v2-content-skeleton__bone is-heading" />
          <div class="v2-content-skeleton__form-grid">
            <div v-for="index in 8" :key="`field-${index}`">
              <span class="v2-content-skeleton__bone is-label" />
              <span class="v2-content-skeleton__bone is-control" />
            </div>
          </div>
          <span class="v2-content-skeleton__bone is-note" />
        </div>
        <aside class="v2-content-skeleton__form-aside">
          <span class="v2-content-skeleton__bone is-heading" />
          <div v-for="index in 3" :key="`candidate-${index}`">
            <span class="v2-content-skeleton__bone is-medium" />
            <span class="v2-content-skeleton__bone is-short" />
          </div>
        </aside>
      </div>
    </template>

    <template v-else-if="kind === 'metrics'">
      <div class="v2-content-skeleton__metrics">
        <section class="v2-content-skeleton__metric-primary">
          <span class="v2-content-skeleton__bone is-label" />
          <span class="v2-content-skeleton__bone is-value" />
          <span class="v2-content-skeleton__bone is-short" />
        </section>
        <section
          v-for="group in 2"
          :key="`metric-group-${group}`"
          class="v2-content-skeleton__metric-group"
        >
          <div v-for="index in 4" :key="`metric-${group}-${index}`">
            <span class="v2-content-skeleton__bone is-label" />
            <span class="v2-content-skeleton__bone is-medium" />
          </div>
        </section>
      </div>
    </template>

    <template v-else-if="kind === 'settings'">
      <div class="v2-content-skeleton__settings">
        <aside>
          <span v-for="index in 7" :key="`nav-${index}`" class="v2-content-skeleton__bone" />
        </aside>
        <section>
          <span class="v2-content-skeleton__bone is-heading" />
          <div class="v2-content-skeleton__settings-controls">
            <span v-for="index in 3" :key="`control-${index}`" class="v2-content-skeleton__bone" />
          </div>
          <div class="v2-content-skeleton__settings-list">
            <span v-for="index in 7" :key="`setting-${index}`" class="v2-content-skeleton__bone" />
          </div>
        </section>
      </div>
    </template>

    <template v-else-if="kind === 'detail'">
      <div class="v2-content-skeleton__detail">
        <span class="v2-content-skeleton__bone is-heading" />
        <dl>
          <div v-for="index in 8" :key="`detail-${index}`">
            <dt><span class="v2-content-skeleton__bone is-label" /></dt>
            <dd><span class="v2-content-skeleton__bone is-medium" /></dd>
          </div>
        </dl>
      </div>
    </template>

    <template v-else-if="kind === 'cards'">
      <div class="v2-content-skeleton__cards">
        <article v-for="index in 4" :key="`card-${index}`">
          <span class="v2-content-skeleton__bone is-heading" />
          <span class="v2-content-skeleton__bone is-long" />
          <span class="v2-content-skeleton__bone is-medium" />
          <span class="v2-content-skeleton__bone is-short" />
        </article>
      </div>
    </template>

    <template v-else>
      <div class="v2-content-skeleton__inline">
        <span class="v2-content-skeleton__bone is-short" />
        <span class="v2-content-skeleton__bone is-long" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { V2SkeletonKind } from './loadingVisuals';

defineProps<{
  kind: V2SkeletonKind;
}>();
</script>

<style scoped>
.v2-content-skeleton {
  width: 100%;
  min-width: 0;
  color: transparent;
}

.v2-content-skeleton__bone {
  display: block;
  min-width: 0;
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(
    100deg,
    var(--v3-skeleton-start) 20%,
    var(--v3-skeleton-mid) 42%,
    var(--v3-skeleton-start) 64%
  );
  background-size: 220% 100%;
  animation: v2-content-skeleton-shimmer 1.45s ease-in-out infinite;
}

.v2-content-skeleton__bone.is-short {
  width: 28%;
}

.v2-content-skeleton__bone.is-medium {
  width: 58%;
}

.v2-content-skeleton__bone.is-long {
  width: 82%;
}

.v2-content-skeleton__bone.is-heading {
  width: 34%;
  height: 18px;
}

.v2-content-skeleton__bone.is-label {
  width: 42%;
  height: 9px;
}

.v2-content-skeleton__bone.is-control {
  width: 100%;
  height: 38px;
}

.v2-content-skeleton__bone.is-note {
  width: 76%;
  height: 56px;
}

.v2-content-skeleton__table,
.v2-content-skeleton__form-main,
.v2-content-skeleton__form-aside,
.v2-content-skeleton__metric-primary,
.v2-content-skeleton__metric-group,
.v2-content-skeleton__settings > aside,
.v2-content-skeleton__settings > section,
.v2-content-skeleton__detail,
.v2-content-skeleton__cards article {
  border: 1px solid var(--v2-border);
  background: var(--v2-surface);
}

.v2-content-skeleton__table {
  overflow: hidden;
  border-radius: 7px;
}

.v2-content-skeleton__table-meta,
.v2-content-skeleton__table-head,
.v2-content-skeleton__table-row,
.v2-content-skeleton__table-footer {
  display: grid;
  align-items: center;
  gap: 18px;
  padding-inline: 16px;
}

.v2-content-skeleton__table-meta {
  grid-template-columns: 1fr 140px;
  min-height: 48px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-content-skeleton__table-head,
.v2-content-skeleton__table-row {
  grid-template-columns: 1.35fr 1fr 1fr 0.85fr 1fr 0.8fr 0.72fr;
}

.v2-content-skeleton__table-head {
  min-height: 42px;
  background: var(--v2-surface-muted);
}

.v2-content-skeleton__table-head .v2-content-skeleton__bone {
  height: 9px;
}

.v2-content-skeleton__table-row {
  min-height: 52px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-content-skeleton__table-row .v2-content-skeleton__bone:nth-child(3n) {
  width: 58%;
}

.v2-content-skeleton__table-row .v2-content-skeleton__bone:nth-child(4n) {
  width: 74%;
}

.v2-content-skeleton__table-footer {
  grid-template-columns: 1fr 260px;
  min-height: 58px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-content-skeleton__table-footer .v2-content-skeleton__bone:last-child {
  justify-self: end;
}

.v2-content-skeleton__form {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(260px, 0.8fr);
  gap: 16px;
}

.v2-content-skeleton__form-main,
.v2-content-skeleton__form-aside,
.v2-content-skeleton__detail {
  display: grid;
  align-content: start;
  gap: 22px;
  padding: 22px;
  border-radius: 8px;
}

.v2-content-skeleton__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 22px;
}

.v2-content-skeleton__form-grid > div,
.v2-content-skeleton__form-aside > div {
  display: grid;
  gap: 8px;
}

.v2-content-skeleton__form-aside > div {
  padding: 16px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 6px;
}

.v2-content-skeleton__metrics {
  display: grid;
  grid-template-columns: minmax(220px, 0.72fr) repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.v2-content-skeleton__metric-primary,
.v2-content-skeleton__metric-group {
  display: grid;
  align-content: center;
  gap: 18px;
  min-height: 188px;
  padding: 20px;
  border-radius: 7px;
}

.v2-content-skeleton__metric-primary .is-value {
  width: 72%;
  height: 38px;
}

.v2-content-skeleton__metric-group {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: stretch;
}

.v2-content-skeleton__metric-group > div {
  display: grid;
  align-content: center;
  gap: 9px;
  padding: 10px;
}

.v2-content-skeleton__settings {
  display: grid;
  grid-template-columns: minmax(170px, 0.25fr) minmax(0, 1fr);
  gap: 14px;
}

.v2-content-skeleton__settings > aside,
.v2-content-skeleton__settings > section {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 16px;
  border-radius: 7px;
}

.v2-content-skeleton__settings > aside .v2-content-skeleton__bone {
  height: 36px;
}

.v2-content-skeleton__settings-controls {
  display: grid;
  grid-template-columns: 1fr 0.6fr 0.4fr;
  gap: 10px;
}

.v2-content-skeleton__settings-controls .v2-content-skeleton__bone {
  height: 38px;
}

.v2-content-skeleton__settings-list {
  display: grid;
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--v2-border-soft);
  border-radius: 6px;
}

.v2-content-skeleton__settings-list .v2-content-skeleton__bone {
  width: 100%;
  height: 49px;
  border-radius: 0;
}

.v2-content-skeleton__detail dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  border: 1px solid var(--v2-border-soft);
  border-radius: 6px;
}

.v2-content-skeleton__detail dl > div {
  display: grid;
  gap: 9px;
  padding: 16px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-content-skeleton__detail dt,
.v2-content-skeleton__detail dd {
  margin: 0;
}

.v2-content-skeleton__cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.v2-content-skeleton__cards article {
  display: grid;
  gap: 13px;
  min-height: 126px;
  padding: 16px;
  border-radius: 7px;
}

.v2-content-skeleton__inline {
  display: grid;
  grid-template-columns: minmax(80px, 0.25fr) minmax(160px, 1fr);
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
}

@keyframes v2-content-skeleton-shimmer {
  from {
    background-position: 120% 0;
  }

  to {
    background-position: -120% 0;
  }
}

@media (max-width: 900px) {
  .v2-content-skeleton__form,
  .v2-content-skeleton__metrics,
  .v2-content-skeleton__settings {
    grid-template-columns: 1fr;
  }

  .v2-content-skeleton__settings > aside {
    grid-template-columns: repeat(4, minmax(110px, 1fr));
    overflow: hidden;
  }
}

@media (max-width: 720px) {
  .v2-content-skeleton__table-meta {
    grid-template-columns: 1fr 90px;
  }

  .v2-content-skeleton__table-head {
    display: none;
  }

  .v2-content-skeleton__table-row {
    grid-template-columns: 1fr 0.62fr;
    grid-auto-rows: 12px;
    gap: 12px 18px;
    min-height: 112px;
    padding-block: 16px;
  }

  .v2-content-skeleton__table-row .v2-content-skeleton__bone:nth-child(n + 5) {
    display: none;
  }

  .v2-content-skeleton__table-footer {
    grid-template-columns: 1fr 150px;
  }

  .v2-content-skeleton__form-grid,
  .v2-content-skeleton__detail dl,
  .v2-content-skeleton__cards {
    grid-template-columns: 1fr;
  }

  .v2-content-skeleton__form-aside {
    display: none;
  }

  .v2-content-skeleton__metric-group {
    min-height: auto;
  }

  .v2-content-skeleton__settings > aside {
    grid-template-columns: repeat(3, minmax(100px, 1fr));
  }

  .v2-content-skeleton__settings-controls {
    grid-template-columns: 1fr 1fr;
  }

  .v2-content-skeleton__settings-controls .v2-content-skeleton__bone:last-child {
    grid-column: 1 / -1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-content-skeleton__bone {
    animation: none;
    background: var(--v3-skeleton-start);
  }
}
</style>
