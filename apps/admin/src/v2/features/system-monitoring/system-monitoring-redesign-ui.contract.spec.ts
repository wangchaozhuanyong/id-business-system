import { describe, expect, it } from 'vitest';
import view from './V2SystemMonitoringView.vue?raw';
import api from './api.ts?raw';
import manifest from './manifest.ts?raw';
import pageState from './useSystemMonitoringPage.ts?raw';
import checks from './components/V2SystemMonitoringChecks.vue?raw';
import details from './components/V2SystemMonitoringDetails.vue?raw';
import navigation from './components/V2SystemMonitoringNavigation.vue?raw';
import fixture from '../../testing/V2SystemMonitoringDesignFixture.vue?raw';

describe('system monitoring scheme 3 redesign contract', () => {
  it('composes the overview, three evidence sections and stable content region', () => {
    expect(view).toContain('<V2SystemMonitoringOverview :page="page" />');
    expect(view).toContain('<V2SystemMonitoringNavigation :page="page" />');
    expect(view).toContain("page.activeSection === 'health'");
    expect(view).toContain('<V2SystemMonitoringDetails v-else');
    expect(view).toContain('@/v2/styles/system-monitoring.css');
    expect(navigation).toContain("key: 'health' as const");
    expect(navigation).toContain("key: 'operations' as const");
    expect(navigation).toContain("key: 'gaps' as const");
    expect(view).toContain('class="v2-system-monitoring-content"');
  });

  it('preserves the admin-only read endpoint and 30 second revalidation', () => {
    expect(manifest).toContain("requiredRoles: ['admin']");
    expect(api).toContain("http.get('/id-business-v2/system-monitoring/overview'");
    expect(pageState).toContain('getRevalidateAt: () => Date.now() + 30_000');
    expect(pageState).toContain("ref<'health' | 'operations' | 'gaps'>('health')");
    expect(details).toContain('本页不启停任务、不修改设置、不下线会话');
  });

  it('keeps unknown distinct from normal and exposes evidence boundaries', () => {
    expect(checks).toContain('未知项不会计入正常');
    expect(checks).toContain('覆盖率只表示有可信证据，不等同于健康率');
    expect(details).toContain('未知不等于正常，也不等于故障');
    expect(details).toContain('page.overview.observabilityGaps');
    expect(details).toContain('display(page.overview.authentication.attempts)');
  });

  it('provides populated and explicit empty fixture states without production writes', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain("key: 'realtime_transport'");
    expect(fixture).toContain("key: 'backup_restore'");
    expect(fixture).toContain('设计验收数据未被修改');
    expect(fixture).not.toContain('http.');
  });
});
