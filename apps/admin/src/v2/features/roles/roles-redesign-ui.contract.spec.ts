import { describe, expect, it } from 'vitest';
import view from './V2RolesView.vue?raw';
import overview from './components/V2RolesOverview.vue?raw';
import toolbar from './components/V2RolesToolbar.vue?raw';
import list from './components/V2RolesList.vue?raw';
import drawer from './components/V2RoleDrawer.vue?raw';
import sensitivePolicy from './components/V2RoleSensitivePolicy.vue?raw';
import pageState from './useRolesPage.ts?raw';
import api from './api.ts?raw';
import manifest from './manifest.ts?raw';
import fixture from '../../testing/V2RolesDesignFixture.vue?raw';

describe('roles scheme 3 redesign contract', () => {
  it('composes overview, compact filters and a stable role list', () => {
    expect(view).toContain('<V2RolesOverview :page="page" />');
    expect(view).toContain('<V2RolesToolbar :page="page" />');
    expect(view).toContain('<V2RolesList :page="page" />');
    expect(view).toContain('<V2RoleDrawer :page="page" />');
    expect(view).toContain('@/v2/styles/roles.css');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain('<V2TableColumnSettings inline');
    expect(list).toContain(':show-column-settings="false"');
    expect(list).toContain('本页 {{ page.items.length }} 条');
  });

  it('preserves role filters, columns and create-edit entry points', () => {
    expect(toolbar).toContain('v-model="page.query.keyword"');
    expect(list).toContain('v2TableSchemas.roles.main.columns[6]');
    expect(list).toContain('page.openEdit(row)');
    expect(overview).toContain('page.openCreate');
    expect(pageState).toContain('activeFilterCount');
    expect(pageState).toContain('keepPreviousData: true');
    expect(pageState).toContain('detailRequest.cancel()');
  });

  it('keeps the existing admin, sensitive-policy and member-safety boundaries', () => {
    expect(manifest).toContain("requiredRoles: ['admin']");
    expect(api).toContain("http.get('/v2/roles/bootstrap'");
    expect(api).toContain("http.post('/v2/roles', input)");
    expect(api).toContain('http.patch(`/v2/roles/${id}`, input)');
    expect(drawer).toContain('page.isSystemRole');
    expect(sensitivePolicy).toContain('page.getSensitiveDisplayMode');
    expect(sensitivePolicy).toContain('page.setSensitiveDisplayMode');
    expect(sensitivePolicy).toContain('密码和密保需点击查看');
    expect(sensitivePolicy).not.toContain('group.permissionCode');
    expect(pageState).toContain('将立即影响该角色下');
    expect(pageState).toContain('validateV2Form(formInstance)');
  });

  it('provides paginated and explicit empty fixture states', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain('Array.from({ length: 23 }');
    expect(fixture).toContain('filtered.slice(start, start + page.query.pageSize)');
    expect(fixture).toContain('预览操作：已打开新建角色入口。');
    expect(fixture).not.toContain('http.');
  });
});
