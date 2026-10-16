<template>
  <section
    class="v2-page-context"
    :class="{
      'v2-page-context--toolbar': !!$slots.filters,
      'v2-page-context--navigation': !!$slots.navigation
    }"
    :aria-label="ariaLabel || ($slots.filters ? '筛选与操作' : '页面说明')"
  >
    <div v-if="$slots.navigation" class="v2-page-context__navigation">
      <slot name="navigation" />
    </div>
    <div v-if="$slots.filters" class="v2-page-context__filters">
      <slot name="filters" />
    </div>
    <div v-else class="v2-page-context__copy">
      <div v-if="$slots.meta" class="v2-page-context__meta">
        <slot name="meta" />
      </div>
      <p>{{ description }}</p>
    </div>
    <div v-if="$slots.filters || $slots.status || $slots.actions" class="v2-page-context__aside">
      <FeatureHelp
        v-if="$slots.filters"
        title="使用说明"
        :text="description"
        placement="bottom"
        :width="380"
      />
      <slot name="status" />
      <slot name="actions" />
    </div>
  </section>
</template>

<script setup lang="ts">
import FeatureHelp from '@/components/ui/FeatureHelp.vue';

withDefaults(
  defineProps<{
    description: string;
    ariaLabel?: string;
  }>(),
  {
    ariaLabel: ''
  }
);
</script>

<style scoped>
.v2-page-context {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--v2-layout-panel-gap);
  padding: var(--v2-layout-panel-padding);
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-page-context__copy {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.v2-page-context--toolbar {
  flex-wrap: wrap;
}

.v2-page-context__filters {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 560px;
}

.v2-page-context__meta,
.v2-page-context__aside {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--v2-layout-control-gap);
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-page-context__copy p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-page-context__aside {
  flex: 0 0 auto;
  justify-content: flex-end;
}

.v2-page-context--navigation {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'navigation aside'
    'filters filters';
  gap: var(--v2-layout-control-gap);
}

.v2-page-context__navigation {
  grid-area: navigation;
  min-width: 0;
}

.v2-page-context__navigation :deep(.el-tabs__header) {
  margin: 0;
}

.v2-page-context--navigation .v2-page-context__filters {
  grid-area: filters;
}

.v2-page-context--navigation .v2-page-context__aside {
  grid-area: aside;
}

@media (max-width: 700px) {
  .v2-page-context {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-page-context__aside {
    width: 100%;
    justify-content: flex-start;
  }

  .v2-page-context__filters {
    width: 100%;
    flex-basis: auto;
  }

  .v2-page-context--navigation {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'navigation'
      'aside'
      'filters';
  }
}
</style>
