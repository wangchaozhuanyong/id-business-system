import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2EmployeesService } from './v2-employees.service';

const operator: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function createEmployee(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'operator01',
    displayName: '运营一号',
    passwordHash: 'hidden',
    phoneEncrypted: 'v1:encrypted-user-phone',
    phoneMasked: '***6789',
    email: null,
    status: 'active',
    lastLoginAt: null,
    createdAt: new Date('2026-07-30T08:00:00.000Z'),
    updatedAt: new Date('2026-07-30T08:00:00.000Z'),
    deletedAt: null,
    userRoles: [
      {
        userId: '22222222-2222-4222-8222-222222222222',
        roleId: '33333333-3333-4333-8333-333333333333',
        role: {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'operation',
          name: '运营'
        }
      }
    ],
    v2AuthIdentity: {
      enabled: true,
      mustResetPassword: true,
      lastAuthenticatedAt: null
    },
    ...overrides
  };
}

function createService() {
  const transaction = {
    user: {
      create: jest.fn(),
      update: jest.fn()
    },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    v2AuthIdentity: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    activeSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 })
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-id' })
    }
  };
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn()
    },
    role: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'operation',
          name: '运营'
        }
      ])
    },
    $transaction: jest.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return input(transaction);
      }
      return Promise.all(input as Promise<unknown>[]);
    })
  };
  const auditLogsService = {
    create: jest.fn(async (input: unknown, client: typeof transaction) =>
      client.auditLog.create({ data: input })
    )
  };
  const securityService = {
    assertPasswordMeetsPolicy: jest.fn().mockResolvedValue(undefined),
    invalidateActiveSessionCache: jest.fn()
  };
  const identityService = {
    invalidateAuthenticatedUser: jest.fn()
  };
  return {
    service: new V2EmployeesService(
      prisma as never,
      auditLogsService as never,
      securityService as never,
      identityService as never
    ),
    prisma,
    transaction,
    auditLogsService,
    securityService,
    identityService
  };
}

describe('V2EmployeesService', () => {
  it('creates a local employee with forced password reset and audits without the password', async () => {
    const fixture = createService();
    const created = createEmployee();
    fixture.prisma.user.findFirst.mockResolvedValue(null);
    fixture.transaction.user.create.mockResolvedValue(created);

    const result = await fixture.service.create(
      {
        username: ' Operator01 ',
        displayName: ' 运营一号 ',
        initialPassword: 'StrongPass1',
        roleIds: ['33333333-3333-4333-8333-333333333333']
      },
      operator
    );

    expect(result).toMatchObject({
      username: 'operator01',
      mustResetPassword: true,
      roles: [{ code: 'operation' }]
    });
    expect(fixture.transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: 'operator01',
          v2AuthIdentity: {
            create: expect.objectContaining({
              mustResetPassword: true,
              enabled: true
            })
          }
        })
      })
    );
    const auditInput = fixture.auditLogsService.create.mock.calls[0]?.[0];
    expect(JSON.stringify(auditInput)).not.toContain('StrongPass1');
    expect(JSON.stringify(auditInput)).not.toContain('encrypted-user-phone');
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('encrypted-user-phone');
  });

  it('rejects creating an employee without a role', async () => {
    const fixture = createService();

    await expect(
      fixture.service.create(
        {
          username: 'operator01',
          displayName: '运营一号',
          initialPassword: 'StrongPass1',
          roleIds: []
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a local account uniqueness conflict to a business conflict', async () => {
    const fixture = createService();
    fixture.prisma.user.findFirst.mockResolvedValue(null);
    fixture.transaction.user.create.mockRejectedValue({
      code: 'P2002'
    });

    await expect(
      fixture.service.create(
        {
          username: 'operator01',
          displayName: '运营一号',
          initialPassword: 'StrongPass1',
          roleIds: ['33333333-3333-4333-8333-333333333333']
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);

    expect(fixture.transaction.user.create).toHaveBeenCalledTimes(1);
  });

  it('prevents an administrator from changing their own status', async () => {
    const fixture = createService();
    fixture.prisma.user.findFirst.mockResolvedValue(
      createEmployee({
        id: operator.id,
        username: operator.username,
        displayName: operator.displayName
      })
    );

    await expect(
      fixture.service.update(operator.id, { status: 'disabled' }, operator)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revokes sessions, disables the identity and writes an atomic audit record', async () => {
    const fixture = createService();
    const existing = createEmployee();
    const updated = createEmployee({
      status: 'disabled',
      v2AuthIdentity: {
        enabled: false,
        mustResetPassword: true,
        lastAuthenticatedAt: null
      }
    });
    fixture.prisma.user.findFirst.mockResolvedValue(existing);
    fixture.transaction.user.update.mockResolvedValue(updated);

    const result = await fixture.service.update(
      existing.id,
      {
        status: 'disabled'
      },
      operator
    );

    expect(result.status).toBe('disabled');
    expect(fixture.transaction.activeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: existing.id,
          revokedAt: null
        }
      })
    );
    expect(fixture.transaction.v2AuthIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          enabled: false
        }
      })
    );
    expect(fixture.auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'employee.update',
        afterData: expect.objectContaining({
          revokedSessionCount: 2
        })
      }),
      fixture.transaction
    );
    expect(fixture.identityService.invalidateAuthenticatedUser).toHaveBeenCalledWith(existing.id);
    expect(fixture.securityService.invalidateActiveSessionCache).toHaveBeenCalledTimes(1);
  });

  it('revokes active sessions atomically when an administrator changes employee roles', async () => {
    const fixture = createService();
    const existing = createEmployee();
    const adminRole = {
      id: '44444444-4444-4444-8444-444444444444',
      code: 'admin',
      name: '管理员'
    };
    const updated = createEmployee({
      userRoles: [
        {
          userId: existing.id,
          roleId: adminRole.id,
          role: adminRole
        }
      ]
    });
    fixture.prisma.user.findFirst.mockResolvedValue(existing);
    fixture.prisma.role.findMany.mockResolvedValue([adminRole]);
    fixture.transaction.user.update.mockResolvedValue(updated);

    await fixture.service.update(existing.id, { roleIds: [adminRole.id] }, operator);

    expect(fixture.transaction.activeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: existing.id,
          revokedAt: null
        }
      })
    );
    expect(fixture.transaction.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: existing.id }
    });
    expect(fixture.auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        afterData: expect.objectContaining({
          rolesChanged: true,
          revokedSessionCount: 2
        })
      }),
      fixture.transaction
    );
  });

  it('keeps sessions when submitted roles are unchanged', async () => {
    const fixture = createService();
    const existing = createEmployee();
    fixture.prisma.user.findFirst.mockResolvedValue(existing);
    fixture.transaction.user.update.mockResolvedValue(existing);

    await fixture.service.update(
      existing.id,
      { roleIds: existing.userRoles.map((userRole) => userRole.roleId) },
      operator
    );

    expect(fixture.transaction.activeSession.updateMany).not.toHaveBeenCalled();
    expect(fixture.transaction.userRole.deleteMany).not.toHaveBeenCalled();
    expect(fixture.transaction.userRole.createMany).not.toHaveBeenCalled();
    expect(fixture.auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        afterData: expect.objectContaining({
          rolesChanged: false,
          revokedSessionCount: 0
        })
      }),
      fixture.transaction
    );
  });
});
