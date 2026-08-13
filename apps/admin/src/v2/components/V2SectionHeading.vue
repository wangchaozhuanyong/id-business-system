<template>
  <component
    :is="as"
    class="v2-section-heading"
    :class="{ 'v2-section-heading--compact': compact }"
  >
    <div class="v2-section-heading__heading">
      <component :is="level" :id="titleId || undefined" class="v2-section-heading__title">
        <span v-if="step !== undefined && step !== ''" class="v2-section-heading__step">
          {{ step }}
        </span>
        <span class="v2-section-heading__text">{{ title }}</span>
      </component>
      <FeatureHelp
        v-if="hasHelp"
        class="v2-section-heading__help"
        :placement="placement"
        :title="title"
        :text="help"
        :width="width"
      />
    </div>

    <div v-if="$slots.actions" class="v2-section-heading__actions">
      <slot name="actions" />
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    titleId?: string;
    help?: string | string[];
    level?: 'h2' | 'h3';
    as?: 'header' | 'div';
    step?: string | number;
    compact?: boolean;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    width?: number;
  }>(),
  {
    help: '',
    titleId: '',
    level: 'h2',
    as: 'header',
    step: '',
    compact: false,
    placement: 'right',
    width: 320
  }
);

const hasHelp = computed(() => {
  const items = Array.isArray(props.help) ? props.help : [props.help];
  return items.some((item) => item.trim().length > 0);
});
</script>

<style scoped>
.v2-section-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-section-heading__heading,
.v2-section-heading__title {
  display: inline-flex;
  min-width: 0;
  align-items: center;
}

.v2-section-heading__heading {
  gap: 4px;
}

.v2-section-heading__title {
  gap: 8px;
  margin: 0;
  color: var(--v2-text);
  font-size: 15px;
  font-weight: var(--v3-font-weight-bold);
  line-height: var(--v3-line-height-tight);
}

h3.v2-section-heading__title,
.v2-section-heading--compact .v2-section-heading__title {
  font-size: 13px;
}

.v2-section-heading__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.v2-section-heading__step {
  display: inline-grid;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  place-items: center;
  border-radius: 50%;
  background: var(--v3-primary-solid);
  color: var(--v3-on-primary-solid);
  font-size: 11px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 1;
}

.v2-section-heading__help {
  margin-left: 0;
}

.v2-section-heading__actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}
</style>
