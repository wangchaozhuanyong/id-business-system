<template>
  <div class="v2-shell v2-exchange-rates-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#exchange-rates">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">汇率记录</span>
            </a>
            <a class="v2-navigation__item" href="#options">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">设置管理</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>汇率记录</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-exchange-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-exchange-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-exchange-page">
            <V2ExchangeRatesOverview :page="page" />
            <V2ExchangeRateTabs :page="page" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
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
import V2ExchangeRatesOverview from '@/v2/features/exchange-rates/components/V2ExchangeRatesOverview.vue';
import V2ExchangeRateTabs from '@/v2/features/exchange-rates/components/V2ExchangeRateTabs.vue';
import type { useExchangeRatesPage } from '@/v2/features/exchange-rates/useExchangeRatesPage';
import {
  receiptFxSourceLabel,
  receiptFxStatusLabel,
  receiptFxStatusType,
  recordStatusLabel,
  recordStatusType,
  trackedCurrencies,
  currencyLabel
} from '@/v2/features/exchange-rates/exchangeRatePresentation';
import type { V2ExchangeRateRecord, V2ManualFxRate } from '@/v2/features/exchange-rates/contracts';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];
const operator = { id: 'operator-1', username: 'admin', displayName: '管理员' };
const notice = ref('');

function makeRecord(index: number): V2ExchangeRateRecord {
  const currencies = ['USDT', 'USD', 'MYR'] as const;
  const currency = currencies[index % currencies.length];
  const p2p = currency === 'USDT';
  const day = String(10 - Math.floor(index / 5)).padStart(2, '0');
  return {
    id: `snapshot-${index + 1}`,
    currency,
    rateToCny:
      currency === 'MYR'
        ? (1.62 + (index % 4) * 0.001).toFixed(4)
        : (7.18 + (index % 5) * 0.002).toFixed(4),
    source: p2p ? 'combined_p2p' : 'ecb_cross',
    sourceReference: p2p ? null : `ECB-${day}-${index + 1}`,
    sourceEvidence: null,
    businessDate: `2026-08-${day}`,
    capturedAt: `2026-08-${day}T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
    expiresAt: `2026-08-${day}T09:${String((index + 30) % 60).padStart(2, '0')}:00.000Z`,
    status: index % 7 === 6 ? 'expired' : 'available',
    exchangeRateRunId: p2p ? `run-${String(index + 1).padStart(8, '0')}` : null,
    createdBy: operator
  };
}

function makeManualEntry(index: number): V2ManualFxRate {
  const currencies = ['MYR', 'USD', 'USDT'] as const;
  const currency = currencies[index % currencies.length];
  const day = String(10 - Math.floor(index / 4)).padStart(2, '0');
  const timestamp = `2026-08-${day}T11:${String(index % 60).padStart(2, '0')}:00.000Z`;
  return {
    id: `manual-${index + 1}`,
    currency,
    rateToCny: currency === 'MYR' ? '1.62180000' : '7.18500000',
    source: 'manual',
    sourceReference: `财务核对单 FX-${String(index + 1).padStart(3, '0')}`,
    businessDate: `2026-08-${day}`,
    recordedAt: timestamp,
    capturedAt: timestamp,
    expiresAt: null,
    reason: index % 3 === 0 ? '客户结算汇率核对' : '供应商账单差异复核',
    createdBy: operator,
    createdAt: timestamp
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allRecords: V2ExchangeRateRecord[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeRecord(index));
const allManualEntries: V2ManualFxRate[] = emptyState
  ? []
  : Array.from({ length: 16 }, (_, index) => makeManualEntry(index));

const page = reactive({
  activeTab: 'automatic' as 'automatic' | 'manual',
  overview: {
    latestRun: {
      id: 'run-00000001',
      status: 'success',
      triggerType: 'scheduled',
      targetAmountRmb: '5000',
      startedAt: '2026-08-10T09:20:00.000Z',
      finishedAt: '2026-08-10T09:20:08.000Z',
      triggeredBy: null,
      error: null,
      snapshot: null
    },
    lastSuccess: {
      id: 'run-00000001',
      status: 'success',
      triggerType: 'scheduled',
      targetAmountRmb: '5000',
      startedAt: '2026-08-10T09:20:00.000Z',
      finishedAt: '2026-08-10T09:20:08.000Z',
      triggeredBy: null,
      error: null,
      stale: false,
      expiresAt: '2026-08-10T09:35:00.000Z',
      snapshot: {
        id: 'snapshot-primary',
        averagedAt: '2026-08-10T09:20:08.000Z',
        combinedMerchantBuyAverageRateToRmb: '7.18240000',
        combinedMerchantSellAverageRateToRmb: '7.19060000',
        midRateToRmb: '7.18650000',
        providerSnapshotCount: 4,
        validSampleCount: 36,
        providers: []
      }
    },
    effective: { available: true, reason: null },
    latestReceiptFxRates: [
      {
        currency: 'CNY',
        snapshotId: null,
        rateToCny: '1',
        source: 'cny_fixed',
        capturedAt: null,
        expiresAt: null,
        status: 'fixed'
      },
      {
        currency: 'USD',
        snapshotId: 'snapshot-usd',
        rateToCny: '7.18420000',
        source: 'ecb_cross',
        capturedAt: '2026-08-10T09:20:08.000Z',
        expiresAt: '2026-08-11T09:20:08.000Z',
        status: 'available'
      },
      {
        currency: 'MYR',
        snapshotId: 'snapshot-myr',
        rateToCny: '1.62180000',
        source: 'ecb_cross',
        capturedAt: '2026-08-10T09:20:08.000Z',
        expiresAt: '2026-08-11T09:20:08.000Z',
        status: 'available'
      }
    ],
    calculationRule: 'latest_available'
  },
  runtime: {
    settings: {
      autoEnabled: true,
      intervalMinutes: 15,
      targetAmountRmb: '5000',
      retentionDays: 30,
      nextRunAt: '2026-08-10T09:35:00.000Z',
      emergencyNetworkEnabled: true,
      updatedByUserId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-10T09:20:00.000Z',
      allowedIntervals: [5, 15, 30, 60],
      allowedRetentionDays: { min: 7, max: 3650 }
    },
    scheduler: {
      tickIntervalMs: 60000,
      localRunning: true,
      lastTickAt: '2026-08-10T09:20:00.000Z',
      databaseRunning: null
    },
    providers: [],
    successBoundary: 'all_sources_available',
    retention: { days: 30, preservesReferencedSnapshots: true }
  },
  latestFailureDescription: '',
  receiptFxRates: [] as Array<{
    currency: 'CNY' | 'MYR' | 'USD' | 'USDT';
    snapshotId: string | null;
    rateToCny: string | null;
    source: string | null;
    capturedAt: string | null;
    expiresAt: string | null;
    status: 'fixed' | 'available' | 'expired' | 'missing';
  }>,
  canCollect: true,
  canManage: true,
  canCreate: true,
  collecting: false,
  headerLoading: false,
  records: [] as V2ExchangeRateRecord[],
  recordTotal: 0,
  recordLoading: false,
  recordError: '',
  recordResolved: true,
  recordDateRange: [] as [string, string] | [],
  manualEntries: [] as V2ManualFxRate[],
  manualTotal: 0,
  manualLoading: false,
  manualError: '',
  manualResolved: true,
  manualDateRange: [] as [string, string] | [],
  trackedCurrencies,
  recordQuery: {
    page: 1,
    pageSize: 10,
    currency: '' as '' | 'MYR' | 'USD' | 'USDT',
    source: '' as '' | 'combined_p2p' | 'binance' | 'okx' | 'ecb_cross',
    status: '' as '' | 'available' | 'expired'
  },
  manualQuery: {
    page: 1,
    pageSize: 10,
    keyword: '',
    currency: '' as '' | 'MYR' | 'USD' | 'USDT'
  },
  collectNow: () => {
    notice.value = '预览操作：已触发一次汇率采集。';
  },
  openSettings: () => {
    notice.value = '预览操作：已打开采集设置。';
  },
  openManualCreate: () => {
    notice.value = '预览操作：已打开人工汇率录入。';
  },
  loadAll: () => {
    notice.value = '汇率概览和当前列表已刷新。';
  },
  searchRecords: () => applyRecordFilters(true),
  loadRecords: () => applyRecordFilters(),
  resetRecordPage: () => applyRecordFilters(true),
  searchManual: () => applyManualFilters(true),
  loadManualEntries: () => applyManualFilters(),
  resetManualPage: () => applyManualFilters(true),
  openRecordEvidence: (record: V2ExchangeRateRecord) => {
    notice.value = `预览操作：正在查看 ${record.currency} 的采集证据。`;
  },
  openManualDetail: (entry: V2ManualFxRate) => {
    notice.value = `预览操作：正在查看 ${entry.currency} 人工汇率记录。`;
  },
  formatRate: (value: string | null | undefined) =>
    value?.replace(/0+$/, '').replace(/\.$/, '') || '—',
  formatAmount: (value: string | null | undefined) => value ?? '—',
  formatDate: (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(value))
      : '—',
  intervalLabel: (minutes: number | undefined) => (minutes ? `${minutes} 分钟` : '—'),
  currencyLabel,
  recordStatusLabel,
  recordStatusType,
  receiptFxStatusLabel,
  receiptFxStatusType,
  receiptFxSourceLabel,
  receiptFxCapturedLabel: (rate: { capturedAt: string | null }) =>
    rate.capturedAt ? '刚刚采集' : '固定汇率',
  operatorName: (entry: V2ManualFxRate) => entry.createdBy?.username || '—'
}) as unknown as ExchangeRatesPage;

page.receiptFxRates = page.overview?.latestReceiptFxRates ?? [];

function applyRecordFilters(resetPage = false) {
  if (resetPage) page.recordQuery.page = 1;
  const filtered = allRecords.filter(
    (record) =>
      (!page.recordQuery.currency || record.currency === page.recordQuery.currency) &&
      (!page.recordQuery.source || record.source === page.recordQuery.source) &&
      (!page.recordQuery.status || record.status === page.recordQuery.status)
  );
  page.recordTotal = filtered.length;
  const start = (page.recordQuery.page - 1) * page.recordQuery.pageSize;
  page.records = filtered.slice(start, start + page.recordQuery.pageSize);
}

function applyManualFilters(resetPage = false) {
  if (resetPage) page.manualQuery.page = 1;
  const keyword = page.manualQuery.keyword.trim().toLowerCase();
  const filtered = allManualEntries.filter(
    (entry) =>
      (!page.manualQuery.currency || entry.currency === page.manualQuery.currency) &&
      (!keyword ||
        [entry.reason, entry.sourceReference, entry.createdBy?.username]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(keyword)))
  );
  page.manualTotal = filtered.length;
  const start = (page.manualQuery.page - 1) * page.manualQuery.pageSize;
  page.manualEntries = filtered.slice(start, start + page.manualQuery.pageSize);
}

applyRecordFilters();
applyManualFilters();
</script>

<style scoped>
.v2-exchange-fixture-avatar {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 13px;
  font-weight: 700;
}

.v2-exchange-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
