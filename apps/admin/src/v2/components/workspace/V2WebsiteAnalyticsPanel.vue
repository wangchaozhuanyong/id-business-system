<template>
  <section class="v2-website-analytics" aria-label="装修网站访问统计">
    <header class="v2-website-analytics__header">
      <div><strong>装修网站访问统计</strong><small>装修网站 · flashcast.com.my</small></div>
      <a :href="V2_FLASHCAST_ANALYTICS.reportUrl" target="_blank" rel="noopener noreferrer"
        >查看完整报表</a
      >
    </header>
    <div v-if="!isAdmin" class="v2-website-analytics__notice" role="note">
      每日访问统计仅管理员可查看。网站健康检测仍可正常使用。
    </div>
    <template v-else>
      <div class="v2-website-analytics__toolbar">
        <el-radio-group v-model="days" size="small" aria-label="访问统计日期范围">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
        </el-radio-group>
        <AppButton
          size="small"
          variant="ghost"
          :disabled="reportQuery.isRefreshing.value"
          @click="reportQuery.refresh"
          >刷新统计</AppButton
        >
      </div>
      <V2AsyncRegion
        :phase="reportQuery.phase.value"
        :previous-data="reportQuery.isPlaceholderData.value"
        :error="errorMessage"
        :empty="false"
        variant="section"
        skeleton="form"
        loading-title="正在读取访问统计"
        refreshing-title="正在更新访问统计"
        error-title="访问统计读取失败"
        @retry="reportQuery.refresh"
      >
        <template v-if="report">
          <div
            v-if="report.status === 'not_configured'"
            class="v2-website-analytics__notice"
            role="status"
          >
            <strong>尚未连接访问报表</strong>
            <p>
              需要管理员配置装修网站统计的专用只读授权。连接后，这里会显示每日浏览量、访客数和访问次数。
            </p>
            <p>暂时可点击“查看完整报表”进入装修网站的统计后台；未连接不代表访问量为零。</p>
          </div>
          <template v-else>
            <p class="v2-website-analytics__context">
              近 {{ report.days }} 天（含今天） · {{ timeZoneLabel }} · 更新于
              {{ formatV2DateTime(report.fetchedAt) }}
            </p>
            <dl class="v2-website-analytics__metrics">
              <div>
                <dt>浏览量</dt>
                <dd>{{ count(report.summary?.pageViews) }}</dd>
              </div>
              <div>
                <dt>访客数</dt>
                <dd>{{ count(report.summary?.visitors) }}</dd>
              </div>
              <div>
                <dt>访问次数</dt>
                <dd>{{ count(report.summary?.sessions) }}</dd>
              </div>
            </dl>
            <div
              v-if="report.status === 'empty'"
              class="v2-website-analytics__notice"
              role="status"
            >
              <strong>此时间范围暂无采集数据</strong>
              <p>
                统计服务尚未返回访问记录，请检查网站埋点或稍后刷新。历史未采集的数据无法通过健康检测补回。
              </p>
            </div>
            <template v-else>
              <div class="v2-website-analytics__daily">
                <V2Table
                  :data="visibleDays"
                  :schema="v2TableSchemas.workspace.websiteAnalytics"
                  :show-column-settings="false"
                >
                  <V2TableColumn
                    :definition="v2TableSchemas.workspace.websiteAnalytics.columns[0]"
                    prop="date"
                  />
                  <V2TableColumn :definition="v2TableSchemas.workspace.websiteAnalytics.columns[1]">
                    <template #default="{ row }">{{ count(row.metrics?.pageViews) }}</template>
                  </V2TableColumn>
                  <V2TableColumn :definition="v2TableSchemas.workspace.websiteAnalytics.columns[2]">
                    <template #default="{ row }">{{ count(row.metrics?.visitors) }}</template>
                  </V2TableColumn>
                  <V2TableColumn :definition="v2TableSchemas.workspace.websiteAnalytics.columns[3]">
                    <template #default="{ row }">{{ count(row.metrics?.sessions) }}</template>
                  </V2TableColumn>
                </V2Table>
              </div>
              <el-pagination
                v-model:current-page="page"
                :page-size="7"
                :total="report.daily.length"
                layout="prev, pager, next"
                small
                aria-label="每日访问记录分页"
              />
            </template>
            <p v-if="report.thresholded" class="v2-website-analytics__notice">
              统计服务对部分数据应用了隐私阈值，报表可能不包含全部访问记录。
            </p>
          </template>
        </template>
      </V2AsyncRegion>
    </template>
    <footer>
      <p>
        浏览量是页面浏览次数；访客数按所选时间范围去重，不能把每天访客数直接相加。统计可能延迟；“—”表示未返回记录。
      </p>
      <p>
        <strong>访客 IP：</strong>当前统计服务不提供原始 IP，IP 明细尚未接入。访客数也不等于独立 IP
        数。
      </p>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  V2_FLASHCAST_ANALYTICS,
  type V2WebsiteAnalyticsDays,
  type V2WebsiteAnalyticsReport
} from '@apple-business/shared';
import { useAuthStore } from '@/stores/auth';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';

const props = defineProps<{ active: boolean }>();
const authStore = useAuthStore();
const isAdmin = computed(() => authStore.user?.roles.includes('admin') === true);
const days = ref<V2WebsiteAnalyticsDays>(7);
const page = ref(1);
const reportQuery = useV2ModuleQuery<V2WebsiteAnalyticsReport>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: () => 'website-analytics-' + days.value,
  enabled: () => props.active && isAdmin.value,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.getWebsiteAnalytics(days.value, { signal })
});
const report = computed(() => reportQuery.data.value);
const errorMessage = computed(() =>
  reportQuery.error.value ? getApiErrorMessage(reportQuery.error.value) : ''
);
const visibleDays = computed(() =>
  [...(report.value?.daily ?? [])].reverse().slice((page.value - 1) * 7, page.value * 7)
);
const timeZoneLabel = computed(() => '统计日期按 ' + (report.value?.utcOffset || '媒体资源时区'));
const numberFormatter = new Intl.NumberFormat('zh-CN');
const count = (value: number | null | undefined) =>
  value == null ? '—' : numberFormatter.format(value);
watch(days, () => {
  void reportQuery.refresh();
});
watch(
  () => props.active,
  (active) => {
    if (active && isAdmin.value) void reportQuery.refresh();
  }
);
watch(
  () => report.value?.days,
  () => {
    page.value = 1;
  }
);
</script>

<style scoped>
.v2-website-analytics {
  min-width: 0;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  padding: 16px;
  background: var(--v2-surface);
}
.v2-website-analytics__header,
.v2-website-analytics__toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.v2-website-analytics__header > div {
  display: grid;
  gap: 4px;
}
.v2-website-analytics__header strong {
  font-size: 14px;
  line-height: 22px;
  color: var(--v2-text);
}
.v2-website-analytics__header a {
  font-size: 12px;
  color: var(--v2-accent);
  text-decoration: underline;
}
.v2-website-analytics__header small,
.v2-website-analytics__context,
.v2-website-analytics footer {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}
.v2-website-analytics__toolbar {
  margin: 16px 0;
}
.v2-website-analytics__metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 12px 0;
  border: 1px solid var(--v2-border);
  border-radius: 7px;
}
.v2-website-analytics__metrics > div {
  min-width: 0;
  padding: 12px;
  border-right: 1px solid var(--v2-border);
}
.v2-website-analytics__metrics > div:last-child {
  border: 0;
}
.v2-website-analytics__metrics dt {
  font-size: 12px;
  line-height: 20px;
  color: var(--v2-text-soft);
}
.v2-website-analytics__metrics dd {
  margin: 4px 0 0;
  font-size: 19px;
  line-height: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.v2-website-analytics__notice {
  margin: 12px 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
  color: var(--v2-text);
  font-size: 13px;
  line-height: 21px;
}
.v2-website-analytics__notice p {
  margin: 6px 0 0;
}
.v2-website-analytics__daily {
  min-height: 344px;
}
.v2-website-analytics :deep(.v2-async-region) {
  min-height: 500px;
}
.v2-website-analytics :deep(.el-pagination) {
  justify-content: flex-end;
  margin-top: 10px;
}
.v2-website-analytics footer {
  margin-top: 14px;
  border-top: 1px solid var(--v2-border-soft);
}
.v2-website-analytics footer p {
  margin: 10px 0 0;
}
@media (max-width: 600px) {
  .v2-website-analytics :deep(.v2-async-region) {
    min-height: 520px;
  }
}
</style>
