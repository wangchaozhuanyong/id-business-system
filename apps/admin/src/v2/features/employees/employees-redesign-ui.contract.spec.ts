import { describe, expect, it } from 'vitest';
import view from './V2EmployeesView.vue?raw';
import overview from './components/V2EmployeesOverview.vue?raw';
import toolbar from './components/V2EmployeesToolbar.vue?raw';
import list from './components/V2EmployeesList.vue?raw';
import drawer from './components/V2EmployeeDrawer.vue?raw';
import pageState from './useEmployeesPage.ts?raw';
import api from './api.ts?raw';
import manifest from './manifest.ts?raw';
import fixture from '../../testing/V2EmployeesDesignFixture.vue?raw';

describe('employees scheme 3 redesign contract', () => {
  it('composes overview, compact filters and a stable list surface', () => {
    expect(view).toContain('<V2EmployeesOverview :page="page" />');
    expect(view).toContain('<V2EmployeesToolbar :page="page" />');
    expect(view).toContain('<V2EmployeesList :page="page" />');
    expect(view).toContain('<V2EmployeeDrawer :page="page" />');
    expect(view).toContain('@/v2/styles/employees.css');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain('<V2TableColumnSettings inline');
    expect(list).toContain(':show-column-settings="false"');
    expect(list).toContain('本页 {{ page.items.length }} 条');
  });

  it('preserves all employee filters, columns and create-edit entry points', () => {
    expect(toolbar).toContain('v-model="page.query.keyword"');
    expect(toolbar).toContain('v-model="page.query.status"');
    expect(toolbar).toContain('v-model="page.query.roleId"');
    expect(list).toContain('v2TableSchemas.employees.main.columns[9]');
    expect(list).toContain('page.openEdit(row)');
    expect(overview).toContain('page.openCreate');
    expect(pageState).toContain('activeFilterCount');
    expect(pageState).toContain('keepPreviousData: true');
  });

  it('keeps the original admin, API and account-safety boundaries', () => {
    expect(manifest).toContain("requiredRoles: ['admin']");
    expect(api).toContain("http.get('/v2/employees/bootstrap'");
    expect(api).toContain("http.post('/v2/employees', input)");
    expect(api).toContain('http.patch(`/v2/employees/${id}`, input)');
    expect(drawer).toContain('当前登录账号不能修改自己的角色或状态');
    expect(pageState).toContain('所有在线会话会立即失效');
    expect(pageState).toContain('确认修改员工权限');
    expect(pageState).toContain('重新登录后新权限才会生效');
    expect(pageState).toContain('expectedUpdatedAt: current.updatedAt');
    expect(drawer).toContain(':title="page.securitySensitiveChangeMessage"');
    expect(pageState).toContain('validateV2Form(formInstance)');
  });

  it('provides paginated and explicit empty fixture states', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain('Array.from({ length: 23 }');
    expect(fixture).toContain('filtered.slice(start, start + page.query.pageSize)');
    expect(fixture).toContain('预览操作：已打开员工开通入口。');
    expect(fixture).not.toContain('http.');
  });
});
