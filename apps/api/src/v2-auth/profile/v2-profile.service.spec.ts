import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { SecurityService } from '../../security/security.service';
import { V2ProfileService } from './v2-profile.service';

describe('V2ProfileService', () => {
  const user: AuthenticatedUser = {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'operator',
    displayName: '操作员',
    roles: ['operator'],
    permissions: [],
    mustResetPassword: false
  };
  const now = new Date('2026-07-31T10:00:00.000Z');

  function createService() {
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: 'operator@example.com',
          phoneMasked: '***6789',
          status: 'active',
          lastLoginAt: now,
          createdAt: now,
          updatedAt: now,
          v2AuthIdentity: {
            mustResetPassword: false,
            lastAuthenticatedAt: now
          },
          userRoles: [{ role: { code: 'operator', name: '操作员' } }]
        })
      }
    } as unknown as PrismaService;
    const securityService = {
      getMyMfaStatus: jest.fn().mockResolvedValue({
        enabled: false,
        configured: false,
        recoveryCodeCount: 0
      }),
      listUserActiveSessions: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20
      }),
      revokeOwnSession: jest.fn().mockResolvedValue({ id: 'session-id' }),
      revokeOtherSessions: jest.fn().mockResolvedValue(2)
    } as unknown as SecurityService;

    return {
      service: new V2ProfileService(prisma, securityService),
      prisma,
      securityService
    };
  }

  it('returns only masked contact data and self-scoped security state', async () => {
    const { service, securityService } = createService();

    const result = await service.bootstrap(user, 'current-token', { page: '1', pageSize: '20' });
    const serialized = JSON.stringify(result);

    expect(result.profile).toMatchObject({
      id: user.id,
      username: 'operator',
      emailMasked: 'o***@example.com',
      phoneMasked: '***6789',
      roles: [{ code: 'operator', name: '操作员' }]
    });
    expect(serialized).not.toContain('operator@example.com');
    expect(serialized).not.toContain('phoneEncrypted');
    expect(securityService.listUserActiveSessions).toHaveBeenCalledWith(
      user.id,
      { page: '1', pageSize: '20', revoked: 'false' },
      'current-token'
    );
  });

  it('delegates session revocation with the authenticated user identity', async () => {
    const { service, securityService } = createService();

    await service.revokeSession('session-id', user, 'current-token');
    await expect(service.revokeOtherSessions(user, 'current-token')).resolves.toEqual({
      revokedCount: 2
    });

    expect(securityService.revokeOwnSession).toHaveBeenCalledWith(
      'session-id',
      user,
      'current-token'
    );
    expect(securityService.revokeOtherSessions).toHaveBeenCalledWith(
      user.id,
      'current-token',
      user
    );
  });
});
