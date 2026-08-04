<template>
  <section v-if="page.overview" class="v2-system-checks" aria-label="系统健康证据清单">
    <header class="v2-system-checks__heading">
      <div>
        <span>只读探针</span>
        <h2>系统健康证据</h2>
      </div>
      <p>异常与未知项优先排列；未知项不会计入正常。</p>
    </header>

    <div class="v2-system-checks__list">
      <article v-for="check in page.sortedChecks" :key="check.key" :class="`is-${check.status}`">
        <span class="v2-system-checks__marker" aria-hidden="true" />
        <div class="v2-system-checks__identity">
          <strong>{{ check.title }}</strong>
          <span>{{ page.systemMonitorStatusMeta(check.status).label }}</span>
        </div>
        <div class="v2-system-checks__evidence">
          <strong>{{ check.value }}</strong>
          <p>{{ page.formatSystemMonitoringDetail(check.detail) }}</p>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;
defineProps<{ page: SystemMonitoringPage }>();
</script>

<style scoped>
.v2-system-checks {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-system-checks__heading {
  display: flex;
  min-width: 0;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-system-checks__heading > div {
  display: grid;
  gap: 3px;
}

.v2-system-checks__heading span {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-system-checks__heading h2 {
  margin: 0;
  color: var(--v2-text);
  font-size: 16px;
}

.v2-system-checks__heading p {
  max-width: 36em;
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
  text-align: right;
}

.v2-system-checks__list {
  display: grid;
  min-width: 0;
}

.v2-system-checks article {
  display: grid;
  min-width: 0;
  grid-template-columns: 5px minmax(130px, 0.58fr) minmax(220px, 1.42fr);
  align-items: center;
  gap: 16px;
  min-height: 84px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-system-checks article:last-child {
  border-bottom: 0;
}

.v2-system-checks__marker {
  width: 5px;
  height: 34px;
  border-radius: 999px;
  background: var(--v2-success);
}

.v2-system-checks article.is-degraded .v2-system-checks__marker {
  background: var(--v2-danger);
}

.v2-system-checks article.is-unknown .v2-system-checks__marker {
  background: var(--v2-text-soft);
}

.v2-system-checks__identity,
.v2-system-checks__evidence {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-system-checks__identity strong,
.v2-system-checks__evidence strong {
  color: var(--v2-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.v2-system-checks__identity > span {
  width: fit-content;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--v2-text-soft);
  background: var(--v2-bg);
  font-size: 10px;
}

.v2-system-checks article.is-degraded .v2-system-checks__identity > span {
  color: var(--v2-danger);
  background: color-mix(in srgb, var(--v2-danger) 8%, transparent);
}

.v2-system-checks__evidence p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

@media (max-width: 600px) {
  .v2-system-checks__heading {
    display: grid;
    gap: 8px;
  }

  .v2-system-checks__heading p {
    text-align: left;
  }

  .v2-system-checks article {
    grid-template-columns: 5px minmax(0, 1fr);
    gap: 12px;
    padding: 14px;
  }

  .v2-system-checks__evidence {
    grid-column: 2;
  }
}
</style>
