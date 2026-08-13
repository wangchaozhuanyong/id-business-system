<template>
  <div class="v2-shell v2-governance-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#data-governance">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">数据治理</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>数据治理</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-governance-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-governance-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-governance-page">
            <V2DataGovernanceOverview :page="page" />
            <V2DataGovernanceNavigation v-model:active-tab="page.activeTab" :page="page" />
            <div class="v2-governance-content">
              <V2DataGovernanceOverviewPanel v-show="page.activeTab === 'overview'" :page="page" />
              <V2DataGovernanceRecyclePanel v-show="page.activeTab === 'recycle'" :page="page" />
              <V2DataGovernanceJobsPanel v-show="page.activeTab === 'jobs'" :page="page" />
            </div>
            <V2DataGovernanceDrawers :page="page" />
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
import V2DataGovernanceDrawers from '@/v2/features/data-governance/components/V2DataGovernanceDrawers.vue';
import V2DataGovernanceJobsPanel from '@/v2/features/data-governance/components/V2DataGovernanceJobsPanel.vue';
import V2DataGovernanceNavigation from '@/v2/features/data-governance/components/V2DataGovernanceNavigation.vue';
import V2DataGovernanceOverview from '@/v2/features/data-governance/components/V2DataGovernanceOverview.vue';
import V2DataGovernanceOverviewPanel from '@/v2/features/data-governance/components/V2DataGovernanceOverviewPanel.vue';
import V2DataGovernanceRecyclePanel from '@/v2/features/data-governance/components/V2DataGovernanceRecyclePanel.vue';
import type {
  V2GovernanceJob,
  V2GovernanceJobDetail,
  V2GovernanceJobStatus,
  V2GovernanceJobType,
  V2GovernanceOverview,
  V2GovernanceRecycleEntity,
  V2GovernanceRecycleItem
} from '@/v2/features/data-governance/contracts';
import {
  formatGovernanceDate,
  getGovernanceItemStatusMeta,
  getGovernanceJobStatusMeta,
  governanceItemStatusMeta,
  governanceJobStatusMeta,
  governanceJobTypeLabel,
  governanceJobTypeLabels,
  recycleEntityLabel,
  recycleEntityLabels,
  shortHash
} from '@/v2/features/data-governance/data-governance-presentation';
import type { useDataGovernancePage } from '@/v2/features/data-governance/useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据中心', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];
const notice = ref('');
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const currentAdminId = 'admin-1';

const overview: V2GovernanceOverview = {
  approvalReadiness: {
    activeAdminCount: 3,
    eligibleApproverCount: 2,
    ready: true,
    blockedReason: null
  },
  recycleBin: {
    total: emptyState ? 0 : 23,
    byEntity: {
      account: emptyState ? 0 : 7,
      customer: emptyState ? 0 : 5,
      option: emptyState ? 0 : 4,
      order: emptyState ? 0 : 7
    },
    recentItems: []
  },
  capabilities: [
    {
      key: 'restore',
      title: '回收站确定性恢复',
      status: 'available',
      detail: '支持 ID 资料、客户、业务选项和订单的受控恢复。'
    },
    {
      key: 'cleanup',
      title: '汇率历史受控清理',
      status: 'available',
      detail: '只清理超过保留期且未被礼品卡引用的已结束采集运行。'
    },
    {
      key: 'approval',
      title: '异人审批',
      status: 'available',
      detail: '预览申请人不能审批自己的任务，审批记录不可修改。'
    },
    {
      key: 'backup',
      title: '托管备份恢复演练',
      status: 'unknown',
      detail: '当前页面只记录外部备份证据，不把未验证的托管恢复描述为已完成。'
    }
  ],
  existingRetention: {
    scope: 'exchange_rate_history_only',
    configured: true,
    lastAuditedRunAt: '2026-08-09T13:20:00.000Z',
    evidenceStatus: 'observed'
  },
  safety: {
    restoreEnabled: true,
    cleanupEnabled: true,
    generalHardDeleteEnabled: false,
    approvalWorkflowConfigured: true
  },
  proposedWorkflow: [
    '冻结确定性影响预览和备份证据',
    '另一名启用管理员复核并审批',
    '按检查点分批执行治理条目',
    '逐项写入结果审计编号',
    '失败条目保留并支持幂等重放'
  ],
  generatedAt: '2026-08-10T09:20:00.000Z',
  timezone: 'Asia/Shanghai'
};

const recycleEntities: V2GovernanceRecycleEntity[] = ['account', 'customer', 'option', 'order'];
const recycleLabels = ['备用美国 ID', '东南亚测试客户', '旧业务分类', '历史退款订单'];
const allRecycleItems: V2GovernanceRecycleItem[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => ({
      id: `recycle-${index + 1}`,
      entity: recycleEntities[index % recycleEntities.length],
      label: `${recycleLabels[index % recycleLabels.length]} ${String(index + 1).padStart(2, '0')}`,
      deletedAt: `2026-08-${String(9 - Math.floor(index / 6)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
      restoreReadiness: 'review_required'
    }));

const jobStatuses: V2GovernanceJobStatus[] = [
  'pending_approval',
  'approved',
  'running',
  'succeeded',
  'partially_succeeded',
  'rejected',
  'cancelled'
];

function createJob(index: number): V2GovernanceJob {
  const status = jobStatuses[index % jobStatuses.length];
  const type: V2GovernanceJobType = index % 3 === 2 ? 'exchange_rate_cleanup' : 'recycle_restore';
  const requestedByUserId = index % 2 === 0 ? currentAdminId : 'admin-2';
  const totalItems = 8 + (index % 5) * 7;
  const completed = ['succeeded', 'partially_succeeded'].includes(status);
  return {
    id: `job-${index + 1}`,
    jobNo: `GOV-20260810-${String(index + 1).padStart(4, '0')}`,
    type,
    status,
    reason: type === 'recycle_restore' ? '核对误删除记录并恢复业务可见性' : '执行汇率历史保留策略',
    backupEvidence: `BACKUP-20260810-${String(index + 1).padStart(3, '0')} · 已核验清单`,
    previewHash: `a8f2b91c${String(index + 1).padStart(4, '0')}d459ef0029c0c11b7d53`,
    previewSummary: {},
    requestedByUserId,
    executedByUserId: completed ? 'admin-3' : null,
    totalItems,
    succeededItems: completed ? totalItems - (status === 'partially_succeeded' ? 1 : 0) : 0,
    skippedItems: status === 'partially_succeeded' ? 1 : 0,
    failedItems: 0,
    approvedAt: ['approved', 'running', 'succeeded', 'partially_succeeded'].includes(status)
      ? '2026-08-10T10:00:00.000Z'
      : null,
    startedAt: ['running', 'succeeded', 'partially_succeeded'].includes(status)
      ? '2026-08-10T10:20:00.000Z'
      : null,
    completedAt: completed ? '2026-08-10T10:42:00.000Z' : null,
    createdAt: `2026-08-${String(10 - Math.floor(index / 6)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:10:00.000Z`,
    updatedAt: '2026-08-10T10:42:00.000Z',
    requestedBy: {
      id: requestedByUserId,
      username: requestedByUserId === currentAdminId ? 'admin' : 'reviewer',
      displayName: requestedByUserId === currentAdminId ? '系统管理员' : '复核管理员'
    },
    executedBy: completed
      ? { id: 'admin-3', username: 'executor', displayName: '执行管理员' }
      : null,
    approval: ['approved', 'running', 'succeeded', 'partially_succeeded'].includes(status)
      ? {
          id: `approval-${index + 1}`,
          decision: 'approved',
          reason: '已核验备份证据、影响范围与预览哈希。',
          previewHash: `a8f2b91c${String(index + 1).padStart(4, '0')}d459ef0029c0c11b7d53`,
          decidedAt: '2026-08-10T10:00:00.000Z',
          approver: { id: 'admin-2', username: 'reviewer', displayName: '复核管理员' }
        }
      : null
  };
}

const allJobs = emptyState ? [] : Array.from({ length: 17 }, (_, index) => createJob(index));

function createDetail(job: V2GovernanceJob): V2GovernanceJobDetail {
  return {
    ...job,
    items: Array.from({ length: Math.min(job.totalItems, 6) }, (_, index) => ({
      id: `detail-item-${index + 1}`,
      sequence: index + 1,
      entityType:
        job.type === 'exchange_rate_cleanup' ? 'exchange_rate_run' : recycleEntities[index % 4],
      entityId: `entity-${index + 1}`,
      safeLabel:
        job.type === 'exchange_rate_cleanup'
          ? `汇率采集运行 ${index + 1}`
          : recycleLabels[index % 4],
      sourceDeletedAt: '2026-08-08T10:00:00.000Z',
      eligibility: {},
      status: job.status === 'succeeded' ? 'succeeded' : 'pending',
      resultCode: job.status === 'succeeded' ? 'restored' : null,
      resultMessage: job.status === 'succeeded' ? '已恢复并写入审计记录' : null,
      resultAuditLogId: job.status === 'succeeded' ? `AUD-${index + 1}` : null,
      processedAt: job.status === 'succeeded' ? '2026-08-10T10:42:00.000Z' : null
    })),
    checkpoints:
      job.status === 'succeeded'
        ? [
            {
              id: 'checkpoint-1',
              batchNo: 1,
              status: 'completed',
              cursorSequence: job.totalItems,
              attemptedItems: job.totalItems,
              succeededItems: job.totalItems,
              skippedItems: 0,
              failedItems: 0,
              errorCode: null,
              startedAt: '2026-08-10T10:20:00.000Z',
              completedAt: '2026-08-10T10:42:00.000Z'
            }
          ]
        : []
  };
}

const fixturePage = reactive({
  activeTab: 'overview' as 'overview' | 'recycle' | 'jobs',
  recycleQueryModel: {
    page: 1,
    pageSize: 10,
    entity: '' as V2GovernanceRecycleEntity | ''
  },
  jobQueryModel: {
    page: 1,
    pageSize: 10,
    type: '' as V2GovernanceJobType | '',
    status: '' as V2GovernanceJobStatus | ''
  },
  selectedRecycleItems: [] as V2GovernanceRecycleItem[],
  restoreDrawerVisible: false,
  cleanupDrawerVisible: false,
  decisionDrawerVisible: false,
  detailDrawerVisible: false,
  restoreFormRef: undefined,
  cleanupFormRef: undefined,
  decisionFormRef: undefined,
  restoreForm: { reason: '', backupEvidence: '' },
  cleanupForm: { olderThanDays: 30, reason: '', backupEvidence: '' },
  decisionForm: { decision: 'approved' as 'approved' | 'rejected', reason: '' },
  decisionTarget: null as V2GovernanceJob | null,
  mutationBusy: '',
  mutationError: '',
  overview,
  recycleItems: [] as V2GovernanceRecycleItem[],
  recycleTotal: allRecycleItems.length,
  recycleCounts: overview.recycleBin.byEntity,
  jobs: [] as V2GovernanceJob[],
  jobsTotal: allJobs.length,
  detail: null as V2GovernanceJobDetail | null,
  overviewLoading: false,
  recycleLoading: false,
  jobsLoading: false,
  detailLoading: false,
  overviewError: '',
  recycleError: '',
  jobsError: '',
  detailError: '',
  previewBlockedReason: '',
  restoreDirty: false,
  cleanupDirty: false,
  decisionDirty: false,
  restoreRules: {},
  cleanupRules: {},
  decisionRules: {},
  overviewHasData: true,
  recycleHasData: true,
  jobsHasData: true,
  detailHasData: true,
  refreshOverview: () => setNotice('治理概况已刷新。'),
  refreshRecycle: () => applyRecyclePage('回收站数据已刷新。'),
  refreshJobs: () => applyJobsPage('治理任务已刷新。'),
  refreshDetail: () => setNotice('任务明细已刷新。'),
  handleRecycleFilterChange: () => {
    fixturePage.recycleQueryModel.page = 1;
    applyRecyclePage('回收站筛选已更新。');
  },
  handleJobFilterChange: () => {
    fixturePage.jobQueryModel.page = 1;
    applyJobsPage('任务筛选已更新。');
  },
  handleRecycleSelection: (items: V2GovernanceRecycleItem[]) => {
    fixturePage.selectedRecycleItems = items;
  },
  isRecycleSelected: (item: V2GovernanceRecycleItem) =>
    fixturePage.selectedRecycleItems.some(
      (selected) => selected.id === item.id && selected.entity === item.entity
    ),
  toggleRecycleSelection: (item: V2GovernanceRecycleItem, selected: boolean) => {
    const remaining = fixturePage.selectedRecycleItems.filter(
      (current) => current.id !== item.id || current.entity !== item.entity
    );
    if (selected) remaining.push(item);
    fixturePage.selectedRecycleItems = remaining;
  },
  openRestoreDrawer: () => {
    if (!fixturePage.selectedRecycleItems.length) {
      setNotice('请先选择需要恢复的回收站记录。');
      return;
    }
    fixturePage.restoreDrawerVisible = true;
  },
  openCleanupDrawer: () => {
    fixturePage.cleanupDrawerVisible = true;
  },
  submitRestore: () => setNotice('预览操作：生成回收站恢复预览。'),
  submitCleanup: () => setNotice('预览操作：生成汇率历史清理预览。'),
  canApprove: (job: V2GovernanceJob) =>
    job.status === 'pending_approval' && job.requestedByUserId !== currentAdminId,
  canCancel: (job: V2GovernanceJob) =>
    job.status === 'pending_approval' && job.requestedByUserId === currentAdminId,
  cancelJob: (job: V2GovernanceJob) => setNotice(`预览操作：取消 ${job.jobNo}。`),
  openDecisionDrawer: (job: V2GovernanceJob) => {
    fixturePage.decisionTarget = job;
    fixturePage.decisionDrawerVisible = true;
  },
  submitDecision: () => setNotice('预览操作：提交治理审批。'),
  executeJob: (job: V2GovernanceJob) => setNotice(`预览操作：执行 ${job.jobNo} 下一批。`),
  openDetail: (job: V2GovernanceJob) => {
    fixturePage.detail = createDetail(job);
    fixturePage.detailDrawerVisible = true;
  },
  beforeClose: (_dirty: boolean, done: () => void) => done(),
  recycleEntityLabels,
  recycleEntityLabel,
  governanceJobTypeLabels,
  governanceJobTypeLabel,
  governanceJobStatusMeta,
  getGovernanceJobStatusMeta,
  governanceItemStatusMeta,
  getGovernanceItemStatusMeta,
  formatGovernanceDate,
  shortHash
});

const page = fixturePage as unknown as DataGovernancePage;

function applyRecyclePage(message?: string) {
  const filtered = fixturePage.recycleQueryModel.entity
    ? allRecycleItems.filter((item) => item.entity === fixturePage.recycleQueryModel.entity)
    : allRecycleItems;
  fixturePage.recycleTotal = filtered.length;
  const start = (fixturePage.recycleQueryModel.page - 1) * fixturePage.recycleQueryModel.pageSize;
  fixturePage.recycleItems = filtered.slice(start, start + fixturePage.recycleQueryModel.pageSize);
  fixturePage.selectedRecycleItems = [];
  if (message) setNotice(message);
}

function applyJobsPage(message?: string) {
  const filtered = allJobs.filter(
    (job) =>
      (!fixturePage.jobQueryModel.type || job.type === fixturePage.jobQueryModel.type) &&
      (!fixturePage.jobQueryModel.status || job.status === fixturePage.jobQueryModel.status)
  );
  fixturePage.jobsTotal = filtered.length;
  const start = (fixturePage.jobQueryModel.page - 1) * fixturePage.jobQueryModel.pageSize;
  fixturePage.jobs = filtered.slice(start, start + fixturePage.jobQueryModel.pageSize);
  if (message) setNotice(message);
}

function setNotice(message: string) {
  notice.value = message;
}

applyRecyclePage();
applyJobsPage();
</script>

<style scoped>
.v2-governance-fixture-avatar {
  display: inline-grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-sidebar);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
}

.v2-governance-fixture-notice {
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
