<template>
  <section class="v2-page-context" :aria-label="ariaLabel">
    <div class="v2-page-context__copy">
      <div v-if="$slots.meta" class="v2-page-context__meta">
        <slot name="meta" />
      </div>
      <p>{{ description }}</p>
    </div>
    <div v-if="$slots.status || $slots.actions" class="v2-page-context__aside">
      <slot name="status" />
      <slot name="actions" />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    description: string;
    ariaLabel?: string;
  }>(),
  {
    ariaLabel: '页面说明'
  }
);
</script>

<style scoped>
.v2-page-context {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-page-context__copy {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.v2-page-context__meta,
.v2-page-context__aside {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
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

@media (max-width: 700px) {
  .v2-page-context {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-page-context__aside {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
