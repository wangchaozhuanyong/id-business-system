import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma/prisma.service';
import { V2IdentityService } from './v2-identity.service';

describe('V2IdentityService', () => {
  it('returns deduplicated roles and permissions for an active V2 operator', async () => {
    const prisma = {
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
      user: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    } as unknown as PrismaService;

    await expect(
      new V2IdentityService(prisma).getAuthenticatedUser('33333333-3333-4333-8333-333333333333')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
