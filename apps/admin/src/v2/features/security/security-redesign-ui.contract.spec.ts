import { describe, expect, it } from 'vitest';
import view from './V2SecurityView.vue?raw';
import overview from './components/V2SecurityOverview.vue?raw';
import navigation from './components/V2SecurityNavigation.vue?raw';
import toolbar from './components/V2SecurityToolbar.vue?raw';
import records from './components/V2SecurityRecordsPanel.vue?raw';
import policy from './components/V2SecurityPolicyPanel.vue?raw';
import mfaUsers from './components/V2SecurityMfaUsersPanel.vue?raw';
import dialogs from './components/V2SecurityPolicyDialogs.vue?raw';
import policyState from './useSecurityPolicyManagement.ts?raw';
import api from './api.ts?raw';
import manifest from './manifest.ts?raw';
import fixture from '../../testing/V2SecurityDesignFixture.vue?raw';

describe('security scheme 3 redesign contract', () => {
  it('composes the shared overview, navigation, filters and stable records', () => {
    expect(view).toContain('<V2SecurityOverview :page="page" />');
    expect(view).toContain('<V2SecurityNavigation :page="page" />');
    expect(view).toContain('<V2SecurityToolbar :page="page" />');
    expect(records).toContain('useV2StableListFrame');
    expect(records).toContain('<V2TableColumnSettings');
    expect(records).toContain(':show-column-settings="false"');
    expect(policy).toContain('v2-security-whitelist-list');
    expect(mfaUsers).toContain('<V2TableColumnSettings inline');
  });

  it('preserves three security views, filters and high-risk actions', () => {
    expect(navigation).toContain('name="login_logs"');
    expect(navigation).toContain('name="sessions"');
    expect(navigation).toContain('name="policy"');
    expect(toolbar).toContain('v-model="page.query.abnormal"');
    expect(toolbar).toContain('v-model="page.query.scope"');
    expect(records).toContain('page.revokeSession(row)');
    expect(policy).toContain('page.openCreateWhitelist');
    expect(overview).toContain("page.selectMetric('abnormal')");
  });

  it('keeps admin permission, APIs and anti-lockout controls', () => {
    expect(manifest).toContain("requiredRoles: ['admin']");
    expect(api).toContain('http.post(`/v2/security/sessions/${id}/revoke`)');
    expect(api).toContain("http.patch('/v2/security/mfa/settings', input)");
    expect(api).toContain("http.post('/v2/security/ip-whitelists', input)");
    expect(records).toContain('当前会话不能在此处强制下线');
    expect(policyState).toContain('仍包含当前请求 IP');
    expect(dialogs).toContain('恢复码只显示这一次');
  });

  it('provides all three paginated fixture views and empty states', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain('Array.from({ length: 23 }');
    expect(fixture).toContain('Array.from({ length: 17 }');
    expect(fixture).toContain('Array.from({ length: 13 }');
    expect(fixture).toContain('Array.from({ length: 12 }');
    expect(fixture).not.toContain('http.');
  });
});
