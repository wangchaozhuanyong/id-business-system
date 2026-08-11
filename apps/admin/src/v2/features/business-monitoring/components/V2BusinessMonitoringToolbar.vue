<template>
  <section class="v2-business-monitoring-command" aria-label="业务异常筛选">
    <V2SectionHeading
      title="异常筛选"
      help="风险级别与业务分类只筛选当前实时队列，不创建或修改任何手工处理状态。"
    >
      <template #actions>
        <span>{{ filterSummary }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-business-monitoring-command__grid">
      <div class="v2-business-monitoring-severity" role="group" aria-label="按风险级别筛选">
        <button
          v-for="item in severityOptions"
          :key="item.value || 'all'"
          type="button"
          :class="{ 'is-active': page.query.severity === item.value }"
          :aria-pressed="page.query.severity === item.value"
          @click="page.applySeverity(item.value)"
        >
          {{ item.label }}
          <span v-if="item.count !== null">{{ item.count }}</span>
        </button>
      </div>

      <el-select
        v-model="page.query.category"
        clearable
        placeholder="全部异常分类"
        aria-label="筛选异常分类"
        @change="page.handleFilterChange"
      >
        <el-option label="订单" value="order" />
        <el-option label="余额" value="balance" />
        <el-option label="续费与开通" value="renewal" />
        <el-option label="汇率采集" value="exchange_rate" />
        <el-option label="财务基线" value="finance" />
      </el-select>

      <div class="v2-business-monitoring-command__actions">
        <AppButton
          variant="ghost"
          :disabled="!page.query.severity && !page.query.category"
          @click="page.resetFilters"
        >
          <el-icon><RefreshLeft /></el-icon>
          重置
        </AppButton>
        <AppButton variant="soft" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
          刷新快照
        </AppButton>
      </div>
    </div>

    <footer>
      <p>
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        本页只展示当前异常；请进入源业务页面修正真实数据。
      </p>
      <span>Asia/Kuala_Lumpur · 30 秒再验证</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled, Refresh, RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { V2BusinessMonitoringSeverity } from '../contracts';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

const props = defineProps<{ page: BusinessMonitoringPage }>();

const severityOptions = computed<
  Array<{ value: V2BusinessMonitoringSeverity | ''; label: string; count: number | null }>
>(() => [
  { value: '', label: '全部', count: props.page.summary?.total ?? null },
  { value: 'critical', label: '紧急', count: props.page.summary?.critical ?? null },
  { value: 'warning', label: '警告', count: props.page.summary?.warning ?? null },
  { value: 'info', label: '提示', count: props.page.summary?.info ?? null }
]);

const filterSummary = computed(() => {
  const labels = [];
  if (props.page.query.severity) {
    labels.push(props.page.businessMonitoringSeverityMeta(props.page.query.severity).label);
  }
  if (props.page.query.category) {
    labels.push(props.page.businessMonitoringCategoryLabel(props.page.query.category));
  }
  return labels.length ? `已筛选：${labels.join(' · ')}` : '未附加筛选';
});
</script>
