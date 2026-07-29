<template>
  <section
    class="v2-page-state"
    :class="`v2-page-state--${state}`"
    :aria-busy="state === 'loading'"
  >
    <template v-if="state === 'loading'">
      <span class="v2-sr-only" role="status" aria-live="polite">{{ title }}</span>
      <V2ContentSkeleton :kind="skeleton" />
    </template>
    <template v-else>
      <strong>{{ title }}</strong>
      <span v-if="message">{{ message }}</span>
      <slot />
    </template>
  </section>
</template>

<script setup lang="ts">
import V2ContentSkeleton from './V2ContentSkeleton.vue';
import type { V2SkeletonKind } from './loadingVisuals';

withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error' | 'forbidden';
    title: string;
    message?: string;
    skeleton?: V2SkeletonKind;
  }>(),
  {
    message: '',
    skeleton: 'table'
  }
);
</script>
