import { describe, expect, it } from 'vitest';
import view from './V2ProfileView.vue?raw';
import overview from './components/V2ProfileOverview.vue?raw';
import sessions from './components/V2ProfileSessionsPanel.vue?raw';
import dialogs from './components/V2ProfileMfaDialogs.vue?raw';
import pageState from './useProfilePage.ts?raw';
import api from './api.ts?raw';
import fixture from '../../testing/V2ProfileDesignFixture.vue?raw';

describe('profile scheme 3 redesign contract', () => {
  it('composes the account overview and stable device list', () => {
    expect(view).toContain('<V2ProfileOverview :page="page" />');
    expect(view).toContain('<V2ProfileSessionsPanel :page="page" />');
    expect(view).toContain('@/v2/styles/profile.css');
    expect(overview).toContain('v2-profile-hero');
    expect(overview).toContain('v2-profile-workspace');
    expect(sessions).toContain('useV2StableListFrame');
    expect(sessions).toContain('<V2TableColumnSettings inline');
    expect(sessions).toContain(':show-column-settings="false"');
  });

  it('preserves masked identity, password, MFA and session actions', () => {
    expect(overview).toContain("page.profile.emailMasked || '未设置'");
    expect(overview).toContain("page.profile.phoneMasked || '未设置'");
    expect(overview).toContain('page.openChangePassword');
    expect(overview).toContain('page.regenerateRecoveryCodes');
    expect(sessions).toContain('page.revokeOtherSessions');
    expect(sessions).toContain("row.isCurrent ? '当前设备' : '退出设备'");
    expect(pageState).toContain("path: '/change-password'");
  });

  it('keeps profile APIs and one-time recovery-code safeguards', () => {
    expect(api).toContain("http.get('/v2/profile/bootstrap'");
    expect(api).toContain('http.post(`/v2/profile/sessions/${id}/revoke`)');
    expect(api).toContain("http.post('/v2/profile/sessions/revoke-others')");
    expect(api).toContain("http.post('/v2/profile/mfa/enable', { code })");
    expect(dialogs).toContain('恢复码只显示这一次');
    expect(dialogs).toContain(':close-on-click-modal="false"');
  });

  it('provides paginated device and explicit empty fixture states', () => {
    expect(fixture).toContain("get('state') === 'empty'");
    expect(fixture).toContain('Array.from({ length: 23 }');
    expect(fixture).toContain('allSessions.slice(start, start + page.query.pageSize)');
    expect(fixture).toContain('ad***@example.com');
    expect(fixture).not.toContain('http.');
  });
});
