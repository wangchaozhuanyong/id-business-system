<template>
  <section data-query-probe>
    <div class="probe-controls">
      <AppButton data-query-refresh :disabled="busy" @click="query.refresh()">刷新资料</AppButton>
      <AppButton data-query-next @click="nextPage">下一页</AppButton>
      <span data-requested-page>当前条件：第 {{ page }} 页</span>
    </div>
    <V2AsyncRegion
      skeleton="cards"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="error"
      loading-title="正在读取验收资料"
      refreshing-title="正在更新验收资料"
      data-query-region
      @retry="query.refresh()"
    >
      <article class="probe-content">
        <strong data-query-data>{{ query.data.value?.label }}</strong>
        <span>刷新时保留成功内容；条件切换期间保持只读。</span>
        <AppButton data-query-action @click="actions += 1">预览操作</AppButton>
        <V2AsyncRegion skeleton="inline" phase="ready" loading-title="正在读取关联资料">
          <AppButton data-nested-action @click="actions += 1">关联区域操作</AppButton>
        </V2AsyncRegion>
        <output data-query-actions>预览次数：{{ actions }}</output>
      </article>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import {
  createV2QueryKey,
  useV2ModuleQuery,
  type V2QueryContext
} from '@/v2/composables/useV2Query';

const props = defineProps<{
  read: (context: V2QueryContext & { page: number }) => Promise<{ label: string }>;
}>();
const page = ref(1);
const actions = ref(0);
const query = useV2ModuleQuery({
  moduleKey: 'orders',
  scope: 'orders',
  trackRouteData: false,
  key: () => createV2QueryKey({ page: page.value }),
  query: ({ signal }) => props.read({ signal, page: page.value })
});
const busy = computed(() => query.isInitialLoading.value || query.isRefreshing.value);
const error = computed(() => (query.error.value instanceof Error ? query.error.value.message : ''));

function nextPage() {
  page.value += 1;
  void query.ensureFresh();
}
</script>

<style scoped>
.probe-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.probe-content {
  display: grid;
  min-height: 260px;
  align-content: start;
  justify-items: start;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.probe-content :deep(.v2-async-region--section) {
  min-height: 0;
}
</style>
