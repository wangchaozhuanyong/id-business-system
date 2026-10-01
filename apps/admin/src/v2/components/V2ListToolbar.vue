<template>
  <section class="v2-list-toolbar" :aria-label="title">
    <div v-if="$slots.navigation" class="v2-list-toolbar__navigation">
      <V2SectionHeading :title="title" :help="help" placement="bottom" />
      <slot name="navigation" />
    </div>
    <V2SectionHeading v-else :title="title" :help="help" placement="bottom" />
    <div v-if="showFilters && $slots.default" class="v2-list-toolbar__fields"><slot /></div>
    <div v-if="showFilters && $slots.actions" class="v2-list-toolbar__actions">
      <slot name="actions" />
    </div>
    <div v-if="$slots.meta" class="v2-list-toolbar__meta"><slot name="meta" /></div>
    <div v-if="$slots.feedback" class="v2-list-toolbar__feedback"><slot name="feedback" /></div>
  </section>
</template>
<script setup lang="ts">
import V2SectionHeading from './V2SectionHeading.vue';
withDefaults(defineProps<{ title: string; help?: string | string[]; showFilters?: boolean }>(), {
  help: '',
  showFilters: true
});
</script>
<style scoped>
.v2-list-toolbar {
  container: v2-toolbar / inline-size;
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--v2-layout-control-gap);
  padding: var(--v2-layout-panel-padding);
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}
.v2-list-toolbar > .v2-section-heading {
  flex: 0 0 auto;
}
.v2-list-toolbar__fields,
.v2-list-toolbar__actions,
.v2-list-toolbar__meta,
.v2-list-toolbar__navigation {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--v2-layout-control-gap);
}
.v2-list-toolbar__fields {
  flex: 1 1 480px;
}
.v2-list-toolbar__actions {
  flex: 0 0 auto;
}
.v2-list-toolbar__meta {
  color: var(--v2-text-soft);
  font-size: 15px;
  line-height: var(--v3-line-height-tight);
}
.v2-list-toolbar__meta :deep(> span) {
  margin: 0;
  font: inherit;
}
.v2-list-toolbar__navigation {
  flex-basis: 100%;
}
.v2-list-toolbar__feedback {
  min-width: 0;
  flex-basis: 100%;
}
.v2-list-toolbar__feedback :deep(> p) {
  margin: 0;
}
.v2-list-toolbar__fields :deep(> .el-form) {
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
}
.v2-list-toolbar__fields :deep(> .el-form .el-form-item) {
  align-items: center;
  margin: 0;
}
.v2-list-toolbar__fields :deep(> .el-form .el-form-item__content) {
  min-width: 0;
}
.v2-list-toolbar__fields :deep(> .el-input) {
  width: auto;
  flex: 1 1 180px;
}
.v2-list-toolbar__fields :deep(> .el-select) {
  width: 140px;
  flex: 0 1 140px;
}
.v2-list-toolbar__fields :deep(> .v2-toolbar-field--wide) {
  width: 180px;
  flex-basis: 180px;
}
.v2-list-toolbar__fields :deep(> .el-date-editor) {
  max-width: 100%;
  min-width: 0;
  flex: 0 1 260px;
}
.v2-list-toolbar__fields :deep(> .v2-filter-disclosure) {
  flex: 0 0 auto;
}
.v2-list-toolbar__fields :deep(> .v2-filter-disclosure .v2-filter-disclosure__panel) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@container v2-toolbar (max-width: 640px) {
  .v2-list-toolbar__fields {
    display: grid;
    flex-basis: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .v2-list-toolbar__fields :deep(> .el-input),
  .v2-list-toolbar__fields :deep(> .el-form),
  .v2-list-toolbar__fields :deep(> .el-date-editor),
  .v2-list-toolbar__fields :deep(> .v2-filter-disclosure) {
    grid-column: 1 / -1;
  }
  .v2-list-toolbar__fields :deep(> .el-form) {
    width: 100%;
  }
  .v2-list-toolbar__fields :deep(> .el-select),
  .v2-list-toolbar__fields :deep(> .v2-toolbar-field--wide) {
    width: 100%;
  }
  .v2-list-toolbar__actions {
    flex: 1 1 auto;
  }
  .v2-list-toolbar__fields :deep(> .v2-filter-disclosure .v2-filter-disclosure__panel) {
    position: static;
    width: 100%;
    min-width: 0;
    margin-top: var(--v2-layout-control-gap);
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
