<template>
  <section
    class="v2-async-region"
    :class="[
      `v2-async-region--${variant}`,
      {
        'is-refreshing': showRefreshFeedback,
        'is-previous-data': isPreviousData
      }
    ]"
    :data-v2-query-phase="effectivePhase"
    :data-v2-previous-data="isPreviousData || undefined"
    :aria-busy="isBusy"
  >
    <V2PageState
      v-if="regionState === 'forbidden'"
      state="forbidden"
      :title="forbiddenTitle"
      :message="forbiddenMessage"
    />

    <V2PageState
      v-else-if="regionState === 'initial-loading'"
      state="loading"
      :title="loadingTitle"
      :skeleton="skeleton"
    />

    <V2PageState
      v-else-if="regionState === 'initial-error'"
      state="error"
      :title="errorTitle"
      :message="error"
    >
      <AppButton variant="primary" @click="$emit('retry')">重新加载</AppButton>
    </V2PageState>

    <template v-else>
      <div
        v-if="effectivePhase === 'refresh-error' && error"
        class="v2-async-region__refresh-error"
        role="alert"
      >
        <strong>{{ isPreviousData ? '新条件加载失败' : '更新失败' }}</strong>
        <span> {{ error }}{{ isPreviousData ? '，以下仍为上次成功结果。' : '' }} </span>
        <AppButton size="small" variant="soft" allow-when-stale @click="$emit('retry')">
          重试
        </AppButton>
      </div>

      <V2PageState
        v-if="regionState === 'empty'"
        state="empty"
        :title="emptyTitle"
        :message="emptyMessage"
      >
        <slot name="empty-action" />
      </V2PageState>

      <div v-else class="v2-async-region__content">
        <slot />
      </div>

      <div
        v-if="showRefreshFeedback"
        class="v2-async-region__progress"
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" />
        <span class="v2-sr-only">{{ refreshingTitle }}，当前内容已保留。</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageState from '@/v2/components/V2PageState.vue';
import {
  resolveLegacyV2QueryPhase,
  resolveV2AsyncRegionState,
  shouldDeferV2RefreshFeedback
} from './asyncRegionState';
import { V2_ASYNC_REGION_PREVIOUS_DATA } from './asyncRegionContext';
import type { V2SkeletonKind } from './loadingVisuals';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';

const REFRESH_FEEDBACK_DELAY_MS = 120;

const props = withDefaults(
  defineProps<{
    phase?: V2QueryPhase;
    previousData?: boolean;
    loading?: boolean;
    resolved?: boolean;
    empty?: boolean;
    error?: string;
    forbidden?: boolean;
    variant?: 'page' | 'section';
    skeleton?: V2SkeletonKind;
    loadingTitle: string;
    refreshingTitle?: string;
    emptyTitle?: string;
    emptyMessage?: string;
    errorTitle?: string;
    forbiddenTitle?: string;
    forbiddenMessage?: string;
  }>(),
  {
    phase: undefined,
    previousData: false,
    loading: false,
    resolved: false,
    empty: false,
    error: '',
    forbidden: false,
    variant: 'page',
    skeleton: 'table',
    refreshingTitle: '正在更新数据',
    emptyTitle: '暂无数据',
    emptyMessage: '当前条件下没有可显示的数据。',
    errorTitle: '数据加载失败',
    forbiddenTitle: '权限不足',
    forbiddenMessage: '当前账号没有访问该数据的权限。'
  }
);

defineEmits<{
  retry: [];
}>();

const showRefreshFeedback = ref(false);
const effectivePhase = computed<V2QueryPhase>(() =>
  props.phase
    ? props.phase
    : resolveLegacyV2QueryPhase({
        loading: props.loading,
        resolved: props.resolved,
        error: props.error
      })
);
const isPreviousData = computed(
  () => props.previousData || effectivePhase.value === 'transitioning'
);
provide(V2_ASYNC_REGION_PREVIOUS_DATA, isPreviousData);
const isBusy = computed(() =>
  ['idle', 'initial-loading', 'refreshing', 'transitioning'].includes(effectivePhase.value)
);
const regionState = computed(() =>
  resolveV2AsyncRegionState({
    forbidden: props.forbidden,
    phase: effectivePhase.value,
    empty: props.empty
  })
);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  showRefreshFeedback.value = false;
}

watch(
  effectivePhase,
  (phase) => {
    clearRefreshTimer();
    if (!shouldDeferV2RefreshFeedback(phase)) return;
    refreshTimer = setTimeout(() => {
      if (shouldDeferV2RefreshFeedback(effectivePhase.value)) showRefreshFeedback.value = true;
    }, REFRESH_FEEDBACK_DELAY_MS);
  },
  { immediate: true }
);

onBeforeUnmount(clearRefreshTimer);
</script>

<style scoped>
.v2-async-region {
  position: relative;
  min-width: 0;
}

.v2-async-region--page {
  min-height: 168px;
}

.v2-async-region--section {
  min-height: 120px;
}

.v2-async-region__content {
  min-width: 0;
}

.v2-async-region.is-previous-data .v2-async-region__content {
  opacity: 0.82;
  transition: opacity 120ms ease;
}

.v2-async-region__refresh-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 6px;
  background: var(--v3-danger-soft);
  color: var(--v2-text-soft);
  font-size: 13px;
}

.v2-async-region__refresh-error strong {
  flex: 0 0 auto;
  color: var(--v2-danger);
}

.v2-async-region__refresh-error span {
  min-width: 0;
  flex: 1;
}

.v2-async-region__progress {
  position: absolute;
  z-index: 4;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  overflow: hidden;
  border-radius: 2px;
  pointer-events: none;
}

.v2-async-region__progress > span:first-child {
  display: block;
  width: 42%;
  height: 100%;
  border-radius: inherit;
  background: var(--v2-accent);
  transform: translateX(-120%);
  animation: v2-async-region-progress 1.05s ease-in-out infinite;
}

@keyframes v2-async-region-progress {
  50% {
    transform: translateX(118%);
  }

  100% {
    transform: translateX(338%);
  }
}

@media (max-width: 720px) {
  .v2-async-region__refresh-error {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-async-region.is-previous-data .v2-async-region__content {
    transition: none;
  }

  .v2-async-region__progress > span:first-child {
    width: 100%;
    animation: none;
    transform: none;
  }
}
</style>
