import { ApiHttpException } from '../common/errors/api-http.exception';
import type { PrismaService } from '../common/prisma/prisma.service';
import { V2IdentityService } from './v2-identity.service';

describe('V2IdentityService', () => {
  it('returns deduplicated roles and permissions for an active V2 operator', async () => {
    const prisma = {
      idBusinessV2ScopeVersion: {
        findUnique: vi.fn().mockResolvedValue({ version: 1n })
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: '33333333-3333-4333-8333-333333333333',
          username: 'admin',
          displayName: '管理员',
          v2AuthIdentity: {
            mustResetPassword: true
          },
          userRoles: [
            {
              role: {
                code: 'admin',
                rolePermissions: [
                  { permission: { code: 'apple.order.view' } },
                  { permission: { code: 'apple.order.view' } }
                ]
              }
            }
          ]
        })
      }
    } as unknown as PrismaService;

    const result = await new V2IdentityService(prisma).getAuthenticatedUser(
      '33333333-3333-4333-8333-333333333333'
    );

    expect(result.roles).toEqual(['admin']);
    expect(result.permissions).toEqual(['apple.order.view']);
    expect(result.mustResetPassword).toBe(true);
  });

  it('rejects missing or disabled operators', async () => {
    const prisma = {
      idBusinessV2ScopeVersion: {
        findUnique: vi.fn().mockResolvedValue({ version: 1n })
      },
      user: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    } as unknown as PrismaService;

    const request = new V2IdentityService(prisma).getAuthenticatedUser(
      '33333333-3333-4333-8333-333333333333'
    );

    await expect(request).rejects.toBeInstanceOf(ApiHttpException);
    await expect(request).rejects.toMatchObject({
      response: {
        errorCode: 'AUTH_ACCOUNT_DISABLED',
        retryable: false
      },
      status: 401
    });
  });

  it('bypasses a stale identity cache after the employee authorization version changes', async () => {
    const versionQuery = vi
      .fn()
      .mockResolvedValueOnce({ version: 1n })
      .mockResolvedValueOnce({ version: 1n })
      .mockResolvedValueOnce({ version: 2n });
    const userQuery = vi
      .fn()
      .mockResolvedValueOnce({
        id: '33333333-3333-4333-8333-333333333333',
        username: 'operator',
        displayName: '运营人员',
        v2AuthIdentity: { mustResetPassword: false },
        userRoles: [
          {
            role: {
              code: 'operation',
              rolePermissions: [{ permission: { code: 'apple.order.update' } }]
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        id: '33333333-3333-4333-8333-333333333333',
        username: 'operator',
        displayName: '运营人员',
        v2AuthIdentity: { mustResetPassword: false },
        userRoles: [
          {
            role: {
              code: 'operation',
              rolePermissions: [{ permission: { code: 'apple.order.view' } }]
            }
          }
        ]
      });
    const prisma = {
      idBusinessV2ScopeVersion: { findUnique: versionQuery },
      user: { findFirst: userQuery }
    } as unknown as PrismaService;
    const service = new V2IdentityService(prisma);

    await expect(
      service.getAuthenticatedUser('33333333-3333-4333-8333-333333333333')
    ).resolves.toMatchObject({ permissions: ['apple.order.update'] });
    await expect(
      service.getAuthenticatedUser('33333333-3333-4333-8333-333333333333')
    ).resolves.toMatchObject({ permissions: ['apple.order.update'] });
    await expect(
      service.getAuthenticatedUser('33333333-3333-4333-8333-333333333333')
    ).resolves.toMatchObject({ permissions: ['apple.order.view'] });
    expect(userQuery).toHaveBeenCalledTimes(2);
  });
});
