<template>
  <div class="v2-shell v2-system-monitoring-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
        </div>
      </div>

      <nav class="v2-navigation" aria-label="设计验收导航">
        <section
          v-for="section in navigation"
          :key="section.title"
          class="v2-navigation__section"
          :class="{ 'is-open': section.active, 'is-active': section.active }"
        >
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><component :is="section.icon" /></el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#system-monitoring">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">系统监控</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>系统监控</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-system-monitoring-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-system-monitoring-fixture-notice" role="status">
            {{ notice }}
          </p>
          <section class="v2-records-page v2-system-monitoring-page">
            <V2SystemMonitoringOverview :page="page" />
            <V2SystemMonitoringNavigation :page="page" />
            <div class="v2-system-monitoring-content">
              <V2SystemMonitoringChecks v-if="page.activeSection === 'health'" :page="page" />
              <V2SystemMonitoringDetails v-else :page="page" />
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Setting,
  User
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2SystemMonitoringChecks from '@/v2/features/system-monitoring/components/V2SystemMonitoringChecks.vue';
import V2SystemMonitoringDetails from '@/v2/features/system-monitoring/components/V2SystemMonitoringDetails.vue';
import V2SystemMonitoringNavigation from '@/v2/features/system-monitoring/components/V2SystemMonitoringNavigation.vue';
import V2SystemMonitoringOverview from '@/v2/features/system-monitoring/components/V2SystemMonitoringOverview.vue';
import type { V2SystemMonitoringResponse } from '@/v2/features/system-monitoring/contracts';
import {
  exchangeRunStatusLabel,
  formatSystemMonitoringDate,
  formatSystemMonitoringDetail,
  sortSystemMonitoringChecks,
  summarizeSystemMonitoringChecks,
  systemMonitorStatusMeta,
  systemOverallStatusMeta
} from '@/v2/features/system-monitoring/system-monitoring-presentation';
import type { useSystemMonitoringPage } from '@/v2/features/system-monitoring/useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];

const notice = ref('');
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';

const overview: V2SystemMonitoringResponse = {
  overallStatus: 'degraded',
  checks: emptyState
    ? []
    : [
        {
          key: 'api',
          title: 'API 探针',
          status: 'healthy',
          value: '本次请求可用',
          detail: '管理端已完成受保护只读探针请求。'
        },
        {
          key: 'database',
          title: '数据库只读连接',
          status: 'healthy',
          value: '18 ms',
          detail: 'SELECT 1 只读探针成功。'
        },
        {
          key: 'change_sync',
          title: '变更版本补偿',
          status: 'unknown',
          value: '4/7 个 scope 已产生版本',
          detail: '最近版本变化：2026-08-10T15:58:00.000Z'
        },
        {
          key: 'exchange_scheduler',
          title: '汇率采集任务',
          status: 'degraded',
          value: '最近一次失败',
          detail: '安全错误码：UPSTREAM_TIMEOUT'
        },
        {
          key: 'authentication',
          title: '认证状态存储',
          status: 'healthy',
          value: '7 个有效会话',
          detail: '最近 24 小时登录 42 次，失败或阻断 3 次，异常标记 1 次。'
        },
        {
          key: 'authentication_availability',
          title: '认证服务 5 分钟可用性',
          status: 'healthy',
          value: '1/160 不可用（0.63%）',
          detail: '未超过 1% 阈值，当前连续 0 次不可用。'
        }
      ],
  authentication: {
    attempts: 42,
    failed: 3,
    abnormal: 1,
    activeSessions: 7
  },
  authAvailability: {
    alert: false,
    consecutiveUnavailable: 0,
    sampledAt: '2026-08-10T16:08:00.000Z',
    status: 'healthy',
    totalChecks: 160,
    unavailableChecks: 1,
    unavailableRate: 0.00625,
    windowMs: 300000
  },
  exchangeRate: {
    executionMode: 'automatic_capable',
    settings: {
      autoEnabled: true,
      intervalMinutes: 30,
      nextRunAt: '2026-08-10T16:30:00.000Z',
      updatedAt: '2026-08-10T15:30:00.000Z'
    },
    latestRun: {
      id: 'run-fixture-1',
      status: 'failed',
      triggerType: 'scheduled',
      startedAt: '2026-08-10T16:00:00.000Z',
      finishedAt: '2026-08-10T16:01:12.000Z',
      errorCode: 'UPSTREAM_TIMEOUT'
    }
  },
  observabilityGaps: emptyState
    ? []
    : [
        {
          key: 'realtime_transport',
          title: 'Realtime 实时通道',
          status: 'unknown',
          detail: '服务端当前只能证明版本补偿表可读，不能证明每个浏览器的私有频道已连接。'
        },
        {
          key: 'historical_errors',
          title: '应用错误历史',
          status: 'unknown',
          detail: '当前未接入持久化错误聚合平台，不能提供历史错误率。'
        },
        {
          key: 'slow_requests',
          title: '慢请求历史',
          status: 'unknown',
          detail: '当前逐请求返回总耗时、认证耗时与业务处理耗时，不保存慢请求时间序列。'
        },
        {
          key: 'backup_restore',
          title: '托管备份与恢复',
          status: 'unknown',
          detail: '应用数据库内没有可信的托管备份或隔离恢复结果，需由目标环境验证。'
        }
      ],
  generatedAt: '2026-08-10T16:08:00.000Z',
  probeDurationMs: 164,
  timezone: 'Asia/Kuala_Lumpur'
};

const activeSection = ref<'health' | 'operations' | 'gaps'>('health');
const sortedChecks = computed(() => sortSystemMonitoringChecks(overview.checks));
const evidenceSummary = computed(() => summarizeSystemMonitoringChecks(overview.checks));

const page = reactive({
  activeSection,
  overview,
  sortedChecks,
  evidenceSummary,
  loading: false,
  error: '',
  hasData: true,
  refresh: () => {
    notice.value = '只读探针已重新执行；设计验收数据未被修改。';
  },
  setActiveSection: (section: 'health' | 'operations' | 'gaps') => {
    activeSection.value = section;
  },
  systemMonitorStatusMeta,
  systemOverallStatusMeta,
  formatSystemMonitoringDate,
  formatSystemMonitoringDetail,
  exchangeRunStatusLabel
}) as unknown as SystemMonitoringPage;
</script>

<style scoped>
.v2-system-monitoring-fixture-avatar {
  display: inline-grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: #eaf1ff;
  color: #194ea8;
  font-size: 12px;
  font-weight: 700;
}

.v2-system-monitoring-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
