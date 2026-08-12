<template>
  <section class="v2-business-monitoring-overview" aria-label="业务监控总览">
    <div class="v2-business-monitoring-overview__intro">
      <span class="v2-business-monitoring-overview__eyebrow">业务风险监控</span>
      <h2>业务风险总览</h2>
      <p>异常直接来自订单、余额、续费、汇率采集和财务基线；修正源数据后自动退出队列。</p>
    </div>

    <div class="v2-business-monitoring-overview__metrics" aria-label="当前业务风险指标">
      <article>
        <span>当前异常</span>
        <strong>{{ page.summary?.total ?? '—' }}</strong>
        <small>当前源数据快照</small>
      </article>
      <article>
        <span>紧急风险</span>
        <strong>{{ page.summary?.critical ?? '—' }}</strong>
        <small>需要优先复核</small>
      </article>
      <article>
        <span>警告风险</span>
        <strong>{{ page.summary?.warning ?? '—' }}</strong>
        <small>需要业务跟进</small>
      </article>
      <article>
        <span>实时规则</span>
        <strong>{{ page.summary ? page.rules.length : '—' }}</strong>
        <small>不维护第二套状态</small>
      </article>
    </div>

    <div class="v2-business-monitoring-overview__actions">
      <span>{{
        page.generatedAt
          ? `更新于 ${page.formatBusinessMonitoringDate(page.generatedAt)}`
          : '等待首个快照'
      }}</span>
      <el-tag type="success" effect="plain">源状态计算</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

defineProps<{ page: BusinessMonitoringPage }>();
</script>
