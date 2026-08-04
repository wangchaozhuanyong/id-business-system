<template>
  <aside v-if="page.overview" class="v2-system-details" aria-label="系统监控证据摘要">
    <section class="v2-system-details__coverage">
      <header>
        <div>
          <span>证据覆盖</span>
          <strong>{{ page.evidenceSummary.coverageRate }}%</strong>
        </div>
        <small
          >{{ page.evidenceSummary.observable }}/{{ page.evidenceSummary.total }} 项可判定</small
        >
      </header>
      <div class="v2-system-details__coverage-bar" aria-hidden="true">
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
      <p>覆盖率只表示有可信证据，不等同于健康率。</p>
    </section>

    <section>
      <V2SectionHeading title="认证快照" help="仅展示聚合计数，不返回账号、IP 或设备信息。" />
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
        <span>未知</span>
      </article>
    </section>
  </aside>
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
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-system-details > section {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
  padding: 18px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-system-details > section:last-child {
  border-bottom: 0;
}

.v2-system-details__coverage {
  background: color-mix(in srgb, var(--v2-accent) 5%, var(--v2-surface));
}

.v2-system-details__coverage header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.v2-system-details__coverage header > div {
  display: grid;
  gap: 4px;
}

.v2-system-details__coverage header span,
.v2-system-details__coverage header small,
.v2-system-details__coverage > p {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-system-details__coverage header strong {
  color: var(--v2-text);
  font-size: 32px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.v2-system-details__coverage-bar {
  height: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--v2-border-soft);
}

.v2-system-details__coverage-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--v2-accent);
}

.v2-system-details__coverage dl {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.v2-system-details__coverage dl div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.v2-system-details__coverage dt {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-system-details__coverage dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 15px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.v2-system-details__coverage dd.is-healthy {
  color: var(--v2-success);
}

.v2-system-details__coverage dd.is-degraded {
  color: var(--v2-danger);
}

.v2-system-details__coverage > p {
  margin: 0;
  line-height: 1.6;
}

.v2-system-details__metrics,
.v2-system-details__list {
  display: grid;
  margin: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
}

.v2-system-details__metrics div,
.v2-system-details__list div {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-system-details__metrics div:last-child,
.v2-system-details__list div:last-child {
  border-bottom: 0;
}

.v2-system-details dt {
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

.v2-system-details__gaps article > span {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--v2-text-soft);
  background: var(--v2-bg);
  font-size: 10px;
}

@media (max-width: 480px) {
  .v2-system-details > section {
    padding: 16px;
  }

  .v2-system-details__coverage header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
