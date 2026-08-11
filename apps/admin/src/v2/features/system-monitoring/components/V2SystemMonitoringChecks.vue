<template>
  <div v-if="page.overview" class="v2-system-health-workspace">
    <section class="v2-system-checks" aria-label="系统健康证据清单">
      <header class="v2-system-checks__heading">
        <V2SectionHeading title="只读探针清单" help="异常与未知项优先排列；未知项不会计入正常。">
          <template #actions>
            <span>本次 {{ page.sortedChecks.length }} 项</span>
            <span aria-hidden="true">·</span>
            <strong>{{ statusSummary }}</strong>
          </template>
        </V2SectionHeading>
      </header>

      <div v-if="page.sortedChecks.length" class="v2-system-checks__list">
        <article v-for="check in page.sortedChecks" :key="check.key" :class="`is-${check.status}`">
          <span class="v2-system-checks__marker" aria-hidden="true" />
          <div class="v2-system-checks__identity">
            <strong>{{ check.title }}</strong>
            <el-tag :type="page.systemMonitorStatusMeta(check.status).type" effect="plain">
              {{ page.systemMonitorStatusMeta(check.status).label }}
            </el-tag>
          </div>
          <div class="v2-system-checks__evidence">
            <strong>{{ check.value }}</strong>
            <p>{{ page.formatSystemMonitoringDetail(check.detail) }}</p>
          </div>
        </article>
      </div>
      <div v-else class="v2-system-monitoring-empty">
        <strong>本次没有可展示的探针证据</strong>
        <span>请重新执行只读探针；未获得证据前不判定为正常。</span>
      </div>
    </section>

    <aside class="v2-system-coverage" aria-label="证据覆盖说明">
      <V2SectionHeading title="证据覆盖" help="覆盖率只表示有可信证据，不等同于健康率。" />
      <div class="v2-system-coverage__score">
        <strong>{{ page.evidenceSummary.coverageRate }}%</strong>
        <span>{{ page.evidenceSummary.observable }}/{{ page.evidenceSummary.total }} 项可判定</span>
      </div>
      <div class="v2-system-coverage__bar" aria-hidden="true">
        <i :style="{ width: `${page.evidenceSummary.coverageRate}%` }" />
      </div>
      <dl>
        <div>
          <dt>正常</dt>
          <dd class="is-healthy">{{ page.evidenceSummary.healthy }}</dd>
        </div>
        <div>
          <dt>异常</dt>
          <dd class="is-degraded">{{ page.evidenceSummary.degraded }}</dd>
        </div>
        <div>
          <dt>未知</dt>
          <dd>{{ page.evidenceSummary.unknown }}</dd>
        </div>
      </dl>
      <div class="v2-system-coverage__boundary">
        <strong>判定边界</strong>
        <p>正常表示本次探针通过；异常表示证据已可判定问题；未知表示证据不足。</p>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;

const props = defineProps<{ page: SystemMonitoringPage }>();

const statusSummary = computed(() => {
  if (props.page.evidenceSummary.degraded) {
    return `${props.page.evidenceSummary.degraded} 项异常`;
  }
  if (props.page.evidenceSummary.unknown) {
    return `${props.page.evidenceSummary.unknown} 项未知`;
  }
  return '已检查项正常';
});
</script>
