import { describe, expect, it } from 'vitest';
import view from './V2AuditLogsView.vue?raw';
import overview from './components/V2AuditLogsOverview.vue?raw';
import navigation from './components/V2AuditLogsNavigation.vue?raw';
import toolbar from './components/V2AuditLogsToolbar.vue?raw';
import list from './components/V2AuditLogsList.vue?raw';
import drawer from './components/V2AuditLogDetailDrawer.vue?raw';
import pageState from './useAuditLogsPage.ts?raw';
import api from './api.ts?raw';
import manifest from './manifest.ts?raw';
import fixture from '../../testing/V2AuditLogsDesignFixture.vue?raw';

describe('audit logs scheme 3 redesign contract', () => {
  it('composes overview, type navigation, filters and a stable list', () => {
    expect(view).toContain('<V2AuditLogsOverview :page="page" />');
    expect(view).toContain('<V2AuditLogsNavigation :page="page" />');
    expect(view).toContain('<V2AuditLogsToolbar :page="page" />');
    expect(view).toContain('<V2AuditLogsList :page="page" />');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain('<V2TableColumnSettings');
    expect(list).toContain(':show-column-settings="false"');
    expect(list).toContain('本页 {{ page.currentItems.length }} 条');
  });

  it('preserves both log types, all filters, pagination and export', () => {
    expect(navigation).toContain('name="operations"');
    expect(navigation).toContain('name="sensitive_access"');
    expect(toolbar).toContain('v-model="page.query.keyword"');
    expect(toolbar).toContain('v-model="page.query.approved"');
    expect(overview).toContain('page.exportCurrent');
    expect(list).toContain('page.openOperationDetails(row)');
    expect(list).toContain('page.openSensitiveDetails(row)');
    expect(pageState).toContain('keepPreviousData: true');
  });

  it('keeps audit permission, APIs and controlled restore boundaries', () => {
    expect(manifest).toContain("permission: 'audit_log.view'");
    expect(api).toContain("http.get('/audit-logs'");
    expect(api).toContain("http.get('/audit-logs/sensitive-access'");
    expect(api).toContain("http.post('/audit-logs/export', input)");
    expect(drawer).toContain('getOperationAuditRestoreCandidate');
    expect(drawer).toContain('发起后只生成数据治理恢复预览');
    expect(pageState).toContain("path: '/v2/data/governance'");
  });

  it('provides both paginated log fixtures and an explicit empty state', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain('Array.from({ length: 23 }');
    expect(fixture).toContain('Array.from({ length: 17 }');
    expect(fixture).toContain('filtered.slice(start, start + page.query.pageSize)');
    expect(fixture).not.toContain('http.');
  });
});
