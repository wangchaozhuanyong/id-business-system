import { describe, expect, it } from 'vitest';
import view from './V2DataGovernanceView.vue?raw';
import pageState from './useDataGovernancePage.ts?raw';
import api from './api.ts?raw';
import overview from './components/V2DataGovernanceOverview.vue?raw';
import navigation from './components/V2DataGovernanceNavigation.vue?raw';
import overviewPanel from './components/V2DataGovernanceOverviewPanel.vue?raw';
import recyclePanel from './components/V2DataGovernanceRecyclePanel.vue?raw';
import jobsPanel from './components/V2DataGovernanceJobsPanel.vue?raw';
import drawers from './components/V2DataGovernanceDrawers.vue?raw';

describe('data governance scheme 3 redesign contract', () => {
  it('composes the governance overview, three navigation sections and existing drawers', () => {
    expect(view).toContain('<V2DataGovernanceOverview :page="page" />');
    expect(view).toContain('v-model:active-tab="page.activeTab"');
    expect(view).toContain('<V2DataGovernanceOverviewPanel');
    expect(view).toContain('<V2DataGovernanceRecyclePanel');
    expect(view).toContain('<V2DataGovernanceJobsPanel');
    expect(view).toContain('<V2DataGovernanceDrawers :page="page" />');
    expect(navigation).toContain("key: 'overview' as const");
    expect(navigation).toContain("key: 'recycle' as const");
    expect(navigation).toContain("key: 'jobs' as const");
  });

  it('preserves admin-only workflow APIs, immutable previews and dual-control rules', () => {
    expect(api).toContain('/restore-jobs/preview');
    expect(api).toContain('/cleanup-jobs/preview');
    expect(api).toContain('/decision');
    expect(api).toContain('/cancel');
    expect(api).toContain('/execute');
    expect(pageState).toContain("job.status === 'pending_approval'");
    expect(pageState).toContain('job.requestedByUserId !== authStore.user?.id');
    expect(pageState).toContain('canCancelGovernanceJob(job, authStore.user?.id)');
    expect(pageState).toContain('backupEvidence: restoreForm.backupEvidence.trim()');
    expect(drawers).toContain('必须由另一名管理员审批');
  });

  it('keeps column settings in both list headings and stabilizes pagination geometry', () => {
    for (const panel of [recyclePanel, jobsPanel]) {
      const settingsIndex = panel.indexOf('<V2TableColumnSettings');
      const pageCountIndex = panel.indexOf('本页 {{');
      const totalIndex = panel.indexOf('共 {{');
      expect(settingsIndex).toBeGreaterThan(-1);
      expect(pageCountIndex).toBeGreaterThan(settingsIndex);
      expect(totalIndex).toBeGreaterThan(pageCountIndex);
      expect(panel).toContain(':show-column-settings="false"');
      expect(panel).toContain('useV2StableListFrame');
    }
  });

  it('shows unknown governance capability explicitly and keeps loading/error boundaries', () => {
    expect(overview).toContain("return '—'");
    expect(overviewPanel).toContain("capability.status === 'blocked'");
    expect(overviewPanel).toContain("'待验证'");
    expect(overviewPanel).toContain('<V2AsyncRegion');
    expect(recyclePanel).toContain('error-title="回收站加载失败"');
    expect(jobsPanel).toContain('error-title="治理任务加载失败"');
  });
});
