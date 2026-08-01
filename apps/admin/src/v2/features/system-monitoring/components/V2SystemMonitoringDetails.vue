<template>
  <div v-if="page.overview" class="v2-system-details">
    <section>
      <V2SectionHeading title="认证运行快照" help="只展示聚合计数，不返回账号、IP 或设备信息。" />
      <dl class="v2-system-details__metrics">
        <div>
          <dt>24 小时登录</dt>
          <dd>{{ display(page.overview.authentication.attempts) }}</dd>
        </div>
        <div>
          <dt>失败或阻断</dt>
          <dd>{{ display(page.overview.authentication.failed) }}</dd>
        </div>
        <div>
          <dt>异常标记</dt>
          <dd>{{ display(page.overview.authentication.abnormal) }}</dd>
        </div>
        <div>
          <dt>有效会话</dt>
          <dd>{{ display(page.overview.authentication.activeSessions) }}</dd>
        </div>
        <div>
          <dt>5 分钟认证不可用率</dt>
          <dd>{{ formatRate(page.overview.authAvailability.unavailableRate) }}</dd>
        </div>
        <div>
          <dt>连续不可用</dt>
          <dd>{{ page.overview.authAvailability.consecutiveUnavailable }}</dd>
        </div>
      </dl>
    </section>

    <section>
      <V2SectionHeading
        title="汇率任务证据"
        help="状态来自数据库设置和最近运行，不代表外部平台始终可用。"
      />
      <dl class="v2-system-details__list">
        <div>
          <dt>运行能力</dt>
          <dd>
            {{
              page.overview.exchangeRate?.executionMode === 'automatic_capable'
                ? '支持自动执行'
                : '仅人工模式'
            }}
          </dd>
        </div>
        <div>
          <dt>自动采集</dt>
          <dd>
            {{
              page.overview.exchangeRate?.settings?.autoEnabled === true
                ? '已启用'
                : page.overview.exchangeRate?.settings
                  ? '已停用'
                  : '未知'
            }}
          </dd>
        </div>
        <div>
          <dt>最近运行</dt>
          <dd>{{ page.exchangeRunStatusLabel(page.overview.exchangeRate?.latestRun?.status) }}</dd>
        </div>
        <div>
          <dt>开始时间</dt>
          <dd>
            {{ page.formatSystemMonitoringDate(page.overview.exchangeRate?.latestRun?.startedAt) }}
          </dd>
        </div>
        <div>
          <dt>安全错误码</dt>
          <dd>{{ page.overview.exchangeRate?.latestRun?.errorCode || '—' }}</dd>
        </div>
        <div>
          <dt>下次计划</dt>
          <dd>
            {{ page.formatSystemMonitoringDate(page.overview.exchangeRate?.settings?.nextRunAt) }}
          </dd>
        </div>
      </dl>
    </section>

    <section class="v2-system-details__gaps">
      <V2SectionHeading
        title="当前不可观测项"
        help="未知不等于正常，也不等于故障；需要接入可信证据后才能判定。"
      />
      <article v-for="gap in page.overview.observabilityGaps" :key="gap.key">
        <div>
          <strong>{{ gap.title }}</strong>
          <p>{{ gap.detail }}</p>
        </div>
        <el-tag type="info" effect="plain">未知</el-tag>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;
defineProps<{ page: SystemMonitoringPage }>();

function display(value: number | null) {
  return value === null ? '未知' : value;
}

function formatRate(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}
</script>

<style scoped>
.v2-system-details {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.v2-system-details > section {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-system-details__metrics,
.v2-system-details__list {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.v2-system-details__metrics div,
.v2-system-details__list div {
  min-width: 0;
}

.v2-system-details dt {
  margin-bottom: 4px;
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-system-details dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 14px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.v2-system-details__gaps {
  grid-column: 1 / -1;
}

.v2-system-details__gaps article {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-system-details__gaps article:last-child {
  border-bottom: 0;
}

.v2-system-details__gaps strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-system-details__gaps p {
  margin: 4px 0 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 800px) {
  .v2-system-details {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-system-details__gaps {
    grid-column: auto;
  }
}

@media (max-width: 480px) {
  .v2-system-details__metrics,
  .v2-system-details__list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
