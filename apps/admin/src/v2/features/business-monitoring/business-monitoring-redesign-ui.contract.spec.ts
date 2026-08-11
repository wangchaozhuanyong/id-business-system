import { describe, expect, it } from 'vitest';
import view from './V2BusinessMonitoringView.vue?raw';
import api from './api.ts?raw';
import pageState from './useBusinessMonitoringPage.ts?raw';
import detail from './components/V2BusinessMonitoringDetail.vue?raw';
import summary from './components/V2BusinessMonitoringSummary.vue?raw';
import toolbar from './components/V2BusinessMonitoringToolbar.vue?raw';
import workspace from './components/V2BusinessMonitoringWorkspace.vue?raw';
import fixture from '../../testing/V2BusinessMonitoringDesignFixture.vue?raw';

describe('business monitoring scheme 3 redesign contract', () => {
  it('composes one overview, category navigation, command panel and stable workspace', () => {
    expect(view).toContain('<V2BusinessMonitoringOverview :page="page" />');
    expect(view).toContain('<V2BusinessMonitoringSummary :page="page" />');
    expect(view).toContain('<V2BusinessMonitoringToolbar :page="page" />');
    expect(view).toContain('<V2BusinessMonitoringWorkspace :page="page" />');
    expect(view).toContain('@/v2/styles/business-monitoring.css');
    expect(summary).toContain('aria-label="\u4e1a\u52a1\u98ce\u9669\u5206\u7c7b"');
    expect(summary).toContain("exchange_rate: '\u91c7\u96c6\u8fd0\u884c\u4e0e\u6c47\u7387'");
  });

  it('keeps column settings beside the page counts and stabilizes list geometry', () => {
    const settingsIndex = workspace.indexOf('<V2TableColumnSettings');
    const pageCountIndex = workspace.indexOf('\u672c\u9875 {{ page.items.length }} \u6761');
    const totalIndex = workspace.indexOf('\u5171 {{ page.total }} \u6761');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(pageCountIndex).toBeGreaterThan(settingsIndex);
    expect(totalIndex).toBeGreaterThan(pageCountIndex);
    expect(workspace).toContain(':show-column-settings="false"');
    expect(workspace).toContain('useV2StableListFrame');
  });

  it('preserves source-state resolution, real route actions and 30 second revalidation', () => {
    expect(api).toContain('/business-monitoring/findings');
    expect(pageState).toContain('getRevalidateAt: () => Date.now() + 30_000');
    expect(pageState).toContain('navigateSafely(router, route)');
    expect(toolbar).toContain('不创建或修改任何手工处理状态');
    expect(detail).toContain('本页不维护“已处理”状态');
    expect(detail).toContain('@click="page.openSource(page.selectedFinding.route)"');
  });

  it('provides populated and empty visual states without replacing business APIs', () => {
    expect(fixture).toContain('Array.from({ length: 27 }');
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain("status: 'open'");
    expect(fixture).toContain("resolutionMode: 'source_state'");
    expect(fixture).toContain('设计验收数据未被修改');
  });
});
