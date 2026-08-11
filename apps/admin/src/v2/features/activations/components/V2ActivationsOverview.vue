<template>
  <div class="v2-activations-overview-stack">
    <section class="v2-activations-overview" aria-label="开通记录概览">
      <div class="v2-activations-overview__intro">
        <span class="v2-activations-overview__eyebrow">ACTIVATION LEDGER</span>
        <h2>开通记录总览</h2>
        <p>集中核对开通、到期和异常状态；到期状态由系统按当前时间动态计算。</p>
      </div>

      <div class="v2-activations-overview__metrics" aria-label="当前页开通指标">
        <article>
          <span>筛选结果</span>
          <strong>{{ page.total }}</strong>
          <small>全部匹配记录</small>
        </article>
        <article>
          <span>当前页</span>
          <strong>{{ page.items.length }}</strong>
          <small>本页已加载</small>
        </article>
        <article>
          <span>正常开通</span>
          <strong>{{ activeCount }}</strong>
          <small>当前页正常记录</small>
        </article>
        <article>
          <span>到期风险</span>
          <strong>{{ riskCount }}</strong>
          <small>当前页临期或异常</small>
        </article>
      </div>

      <div class="v2-activations-overview__actions">
        <AppButton variant="ghost" :disabled="page.loading" @click="page.loadActivations">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
      </div>
    </section>

    <V2StatusStrip
      :items="page.activationStatusStripItems"
      :active-key="page.query.dueStatus"
      aria-label="当前页开通到期分布"
      @select="page.selectDueStatus"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import type { useActivationsPage } from '../useActivationsPage';

type ActivationsPage = UnwrapNestedRefs<ReturnType<typeof useActivationsPage>>;

const props = defineProps<{
  page: ActivationsPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.status.code === 'active').length
);
const riskCount = computed(
  () =>
    props.page.items.filter((item) =>
      [
        'due_within_1_hour',
        'due_within_23_hours',
        'due_within_7_days',
        'expired',
        'abnormal'
      ].includes(item.status.code)
    ).length
);
</script>
