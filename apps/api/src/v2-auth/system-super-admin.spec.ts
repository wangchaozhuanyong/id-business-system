import { describe, it, expect, vi } from 'vitest';
import {
  ensureSystemSuperAdmin,
  getEmployeeBusinessOwnerIds,
  getSystemSuperAdminUserId,
  requireSystemSuperAdmin,
  SYSTEM_SUPER_ADMIN_KEY,
  EMPLOYEE_TAKEOVER_PREFIX
} from './system-super-admin';
import { V2IdentityService } from './v2-identity.service';

const ownerId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';

describe('unique system super administrator', () => {
  it('binds the designated existing account under a transaction lock and audits once', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      securitySetting: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: ownerId,
          status: 'active',
          deletedAt: null,
          v2AuthIdentity: { enabled: true }
        })
      },
      role: { findUnique: vi.fn().mockResolvedValue({ id: 'admin-role' }) },
      userRole: { upsert: vi.fn() },
      auditLog: { create: vi.fn() }
    };
    const prisma = {
      securitySetting: tx.securitySetting,
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    expect(await ensureSystemSuperAdmin(prisma as never)).toBe(ownerId);
    expect(tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: 'ppfzj1314' } })
    );
    expect(tx.securitySetting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: SYSTEM_SUPER_ADMIN_KEY, value: { userId: ownerId } })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    tx.securitySetting.findUnique.mockResolvedValue({ value: { userId: ownerId } } as never);
    expect(await ensureSystemSuperAdmin(prisma as never)).toBe(ownerId);
    expect(tx.securitySetting.create).toHaveBeenCalledOnce();
  });

  it('does not fall back to another administrator when the designated account is absent', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      securitySetting: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue(null) }
    };
    const prisma = {
      securitySetting: tx.securitySetting,
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    expect(await ensureSystemSuperAdmin(prisma as never)).toBeNull();
    expect(tx.securitySetting.create).not.toHaveBeenCalled();
  });

  it('rejects a broken registry instead of guessing a privileged user', async () => {
    const client = {
      securitySetting: { findUnique: vi.fn().mockResolvedValue({ value: { userId: 'invalid' } }) }
    };
    await expect(getSystemSuperAdminUserId(client as never)).rejects.toThrow('绑定异常');
  });

  it('uses the registry rather than a forged role assignment or username', async () => {
    const client = {
      idBusinessV2ScopeVersion: { findUnique: vi.fn().mockResolvedValue({ version: 1n }) },
      securitySetting: { findUnique: vi.fn().mockResolvedValue({ value: { userId: ownerId } }) },
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: employeeId,
          username: 'ppfzj1314',
          displayName: '员工',
          v2AuthIdentity: { mustResetPassword: false },
          userRoles: [{ role: { code: 'super_admin', rolePermissions: [] } }]
        })
      }
    };
    const result = await new V2IdentityService(client as never).getAuthenticatedUser(employeeId);
    expect(result.roles).not.toContain('super_admin');
    await expect(requireSystemSuperAdmin(client as never, employeeId)).rejects.toThrow(
      '仅系统超级管理员'
    );
  });

  it('only exposes explicitly acquired business owners to the registered administrator', async () => {
    const client = {
      securitySetting: {
        findUnique: vi.fn().mockResolvedValue({ value: { userId: ownerId } }),
        findMany: vi.fn().mockResolvedValue([
          {
            key: `${EMPLOYEE_TAKEOVER_PREFIX}${employeeId}`,
            value: { sourceUserId: employeeId, targetUserId: ownerId }
          },
          {
            key: `${EMPLOYEE_TAKEOVER_PREFIX}33333333-3333-4333-8333-333333333333`,
            value: { targetUserId: employeeId }
          },
          { key: `${EMPLOYEE_TAKEOVER_PREFIX}invalid`, value: { targetUserId: ownerId } }
        ])
      }
    };
    expect(await getEmployeeBusinessOwnerIds(client as never, ownerId)).toEqual([
      ownerId,
      employeeId
    ]);
    expect(await getEmployeeBusinessOwnerIds(client as never, employeeId)).toEqual([employeeId]);
  });
});
