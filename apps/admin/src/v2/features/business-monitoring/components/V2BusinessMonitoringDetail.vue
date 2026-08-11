<template>
  <aside class="v2-monitoring-detail" aria-label="选中异常详情" aria-live="polite">
    <template v-if="page.selectedFinding">
      <header>
        <div>
          <span>处置焦点</span>
          <h2>{{ page.selectedFinding.subject }}</h2>
        </div>
        <el-tag
          :type="page.businessMonitoringSeverityMeta(page.selectedFinding.severity).type"
          effect="plain"
        >
          {{ page.businessMonitoringSeverityMeta(page.selectedFinding.severity).label }}
        </el-tag>
      </header>

      <p>{{ page.selectedFinding.description }}</p>

      <dl>
        <div>
          <dt>业务分类</dt>
          <dd>{{ page.businessMonitoringCategoryLabel(page.selectedFinding.category) }}</dd>
        </div>
        <div>
          <dt>发现时间</dt>
          <dd>{{ page.formatBusinessMonitoringDate(page.selectedFinding.detectedAt) }}</dd>
        </div>
        <div>
          <dt>判定规则</dt>
          <dd>{{ page.selectedFinding.ruleKey }}</dd>
        </div>
        <div>
          <dt>退出条件</dt>
          <dd>修正源数据后自动消失</dd>
        </div>
      </dl>

      <div class="v2-monitoring-detail__note">
        <strong>处理边界</strong>
        <span>本页不维护“已处理”状态；请回到业务源页面修正真实数据。</span>
      </div>

      <AppButton variant="primary" @click="page.openSource(page.selectedFinding.route)">
        打开源数据
      </AppButton>
    </template>

    <div v-else class="v2-monitoring-detail__empty">
      <span>处置焦点</span>
      <strong>当前没有可查看的异常</strong>
      <p>调整筛选条件，或等待下一次实时计算。</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

defineProps<{ page: BusinessMonitoringPage }>();
</script>
