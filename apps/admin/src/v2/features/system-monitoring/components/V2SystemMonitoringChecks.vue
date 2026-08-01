<template>
  <section v-if="page.overview" class="v2-system-checks" aria-label="系统健康检查">
    <article v-for="check in page.overview.checks" :key="check.key" :class="`is-${check.status}`">
      <header>
        <strong>{{ check.title }}</strong>
        <el-tag :type="page.systemMonitorStatusMeta(check.status).type" effect="plain">
          {{ page.systemMonitorStatusMeta(check.status).label }}
        </el-tag>
      </header>
      <span>{{ check.value }}</span>
      <p>{{ check.detail }}</p>
    </article>
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.v2-system-checks article {
  display: grid;
  min-width: 0;
  min-height: 138px;
  align-content: start;
  gap: 9px;
  padding: 15px;
  border: 1px solid var(--v2-border);
  border-left: 3px solid var(--v2-success);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-system-checks article.is-degraded {
  border-left-color: var(--v2-danger);
}

.v2-system-checks article.is-unknown {
  border-left-color: var(--v2-text-soft);
}

.v2-system-checks header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.v2-system-checks strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-system-checks > article > span {
  color: var(--v2-text);
  font-size: 16px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.v2-system-checks p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

@media (max-width: 1050px) {
  .v2-system-checks {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .v2-system-checks {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
