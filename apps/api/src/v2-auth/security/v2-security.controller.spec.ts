import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { SecurityService } from '../../security/security.service';
import { V2SecurityController } from './v2-security.controller';

const operator: AuthenticatedUser = {
  id: '667e3417-0317-4ab6-a985-cfed33915815',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function createController() {
  const securityService = {
    overview: vi.fn().mockResolvedValue({ activeSessionCount: 1 }),
    listLoginLogs: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    listActiveSessions: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    getMfaSettings: vi.fn().mockResolvedValue({ key: 'mfa_settings', value: {} }),
    updateMfaSettingsSafely: vi.fn().mockResolvedValue({ key: 'mfa_settings', value: {} }),
    getMyMfaStatus: vi.fn().mockResolvedValue({ enabled: false, configured: false }),
    listMfaUsers: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    listIpWhitelists: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    createIpWhitelistSafely: vi.fn().mockResolvedValue({ id: 'ip-whitelist-id' }),
    removeIpWhitelistSafely: vi.fn().mockResolvedValue({ deleted: true }),
    revokeSession: vi.fn().mockResolvedValue({ id: 'session-id', revokedAt: new Date() })
  } as unknown as SecurityService;

  return {
    controller: new V2SecurityController(securityService),
    securityService
  };
}

describe('V2SecurityController', () => {
  it('returns the security bootstrap and marks the bearer session context', async () => {
    const { controller, securityService } = createController();

    const result = await controller.bootstrap(operator, 'Bearer current-session-token', '1', '20');

    expect(result.overview).toEqual({ activeSessionCount: 1 });
    expect(securityService.listActiveSessions).toHaveBeenCalledWith(
      { page: '1', pageSize: '20', revoked: 'false' },
      'current-session-token'
    );
    expect(securityService.getMyMfaStatus).toHaveBeenCalledWith(operator);
  });

  it('does not forward malformed authorization values as session identifiers', async () => {
    const { controller, securityService } = createController();

    await controller.listSessions('Basic credentials', '2', '50', 'admin', 'false');

    expect(securityService.listActiveSessions).toHaveBeenCalledWith(
      {
        page: '2',
        pageSize: '50',
        keyword: 'admin',
        revoked: 'false',
        sortBy: undefined,
        sortOrder: undefined
      },
      undefined
    );
  });

  it('delegates session revocation with the authenticated operator', async () => {
    const { controller, securityService } = createController();

    await controller.revokeSession('session-id', operator);

    expect(securityService.revokeSession).toHaveBeenCalledWith('session-id', operator);
  });

  it('uses the guarded policy and whitelist mutation paths', async () => {
    const { controller, securityService } = createController();
    const settings = {
      enabled: true,
      requiredForAdmins: false,
      issuer: '代充管理后台'
    };
    const whitelist = {
      ipOrCidr: '10.0.0.0/24',
      scope: 'admin',
      enabled: true,
      remark: 'office'
    };

    await controller.updateMfaSettings(settings, operator);
    await controller.createIpWhitelist(whitelist, operator, '10.0.0.25');
    await controller.removeIpWhitelist(
      '44444444-4444-4444-8444-444444444444',
      operator,
      '10.0.0.25',
      '2026-08-30T00:00:00.000Z'
    );

    expect(securityService.updateMfaSettingsSafely).toHaveBeenCalledWith(settings, operator);
    expect(securityService.createIpWhitelistSafely).toHaveBeenCalledWith(
      whitelist,
      operator,
      '10.0.0.25'
    );
    expect(securityService.removeIpWhitelistSafely).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      operator,
      '10.0.0.25',
      '2026-08-30T00:00:00.000Z'
    );
  });
});
