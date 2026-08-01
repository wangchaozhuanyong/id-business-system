import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2ProfileService } from './v2-profile.service';
import { V2ProfileController } from './v2-profile.controller';

const user: AuthenticatedUser = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'operator',
  displayName: '操作员',
  roles: ['operator'],
  permissions: []
};

function createController() {
  const profileService = {
    bootstrap: vi.fn().mockResolvedValue({ profile: {}, sessions: { items: [] } }),
    listSessions: vi.fn().mockResolvedValue({ items: [] }),
    revokeSession: vi.fn().mockResolvedValue({ id: 'session-id' }),
    revokeOtherSessions: vi.fn().mockResolvedValue({ revokedCount: 1 }),
    getProfile: vi.fn().mockResolvedValue({ id: user.id }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: false }),
    setupMfa: vi.fn().mockResolvedValue({ secret: 'secret' }),
    enableMfa: vi.fn().mockResolvedValue({ enabled: true }),
    regenerateMfaRecoveryCodes: vi.fn().mockResolvedValue({ recoveryCodes: [] }),
    disableMfa: vi.fn().mockResolvedValue({ enabled: false })
  } as unknown as V2ProfileService;

  return {
    controller: new V2ProfileController(profileService),
    profileService
  };
}

describe('V2ProfileController', () => {
  it('passes only the bearer session and authenticated user to bootstrap', async () => {
    const { controller, profileService } = createController();

    await controller.bootstrap(user, 'Bearer current-token', '2', '10');

    expect(profileService.bootstrap).toHaveBeenCalledWith(user, 'current-token', {
      page: '2',
      pageSize: '10'
    });
  });

  it('never accepts a target user id for self-service session mutations', async () => {
    const { controller, profileService } = createController();

    await controller.revokeSession('session-id', user, 'Bearer current-token');
    await controller.revokeOtherSessions(user, 'Bearer current-token');

    expect(profileService.revokeSession).toHaveBeenCalledWith('session-id', user, 'current-token');
    expect(profileService.revokeOtherSessions).toHaveBeenCalledWith(user, 'current-token');
  });

  it('does not forward malformed authorization values as session identifiers', async () => {
    const { controller, profileService } = createController();

    await controller.listSessions(user, 'Basic credentials', '1', '20');

    expect(profileService.listSessions).toHaveBeenCalledWith(user, undefined, {
      page: '1',
      pageSize: '20'
    });
  });
});
