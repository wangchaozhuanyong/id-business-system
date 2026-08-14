import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2RolesService } from './v2-roles.service';

const operator: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

const permissionView = {
  id: '33333333-3333-4333-8333-333333333333',
  name: '查看订单',
  code: 'apple.order.view',
  module: 'apple.order',
  action: 'view'
};

const permissionUpdate = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '修改订单',
  code: 'apple.order.update',
  module: 'apple.order',
  action: 'update'
};

const permissionSensitive = {
  id: '66666666-6666-4666-8666-666666666666',
  name: '查看 ID 密码',
  code: 'apple.secret.view_password',
  module: 'apple.secret',
  action: 'view_password'
};

const permissionAppleId = {
  id: '77777777-7777-4777-8777-777777777777',
  name: '查看完整 Apple ID',
  code: 'apple.account.view_full',
  module: 'apple.account',
  action: 'view_full'
};

function createRole(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: '运营',
    code: 'operation',
    description: '处理日常订单',
    createdAt: new Date('2026-07-30T08:00:00.000Z'),
    updatedAt: new Date('2026-07-30T08:00:00.000Z'),
    rolePermissions: [
      { roleId: 'role-id', permissionId: permissionView.id, permission: permissionView }
    ],
    sensitiveDisplayPolicies: [],
    userRoles: [
      {
        userId: '55555555-5555-4555-8555-555555555555',
        roleId: '22222222-2222-4222-8222-222222222222',
        user: {
          id: '55555555-5555-4555-8555-555555555555',
          username: 'operator01',
          displayName: '运营一号',
          status: 'active'
        }
      }
    ],
    _count: {
      userRoles: 1
    },
    ...overrides
  };
}

function createService() {
  const transaction = {
    role: {
      create: jest.fn(),
      update: jest.fn()
    },
    rolePermission: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    idBusinessV2SensitiveDisplayPolicy: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 })
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-id' })
    }
  };
  const prisma = {
    role: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn()
    },
    permission: {
      findMany: jest.fn()
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
  const identityService = {
    invalidateAuthenticatedUser: jest.fn()
  };

  return {
    service: new V2RolesService(
      prisma as never,
      auditLogsService as never,
      identityService as never
    ),
    prisma,
    transaction,
    auditLogsService,
    identityService
  };
}

describe('V2RolesService', () => {
  it('creates a custom role with permissions and an audit record', async () => {
    const fixture = createService();
    const created = createRole();
    fixture.prisma.role.findFirst.mockResolvedValue(null);
    fixture.prisma.permission.findMany.mockResolvedValue([
      {
        id: permissionView.id,
        code: permissionView.code
      }
    ]);
    fixture.transaction.role.create.mockResolvedValue(created);

    const result = await fixture.service.create(
      {
        name: ' 运营 ',
        code: ' Operation ',
        description: ' 处理日常订单 ',
        permissionIds: [permissionView.id]
      },
      operator
    );

    expect(result).toMatchObject({
      name: '运营',
      code: 'operation',
      permissionIds: [permissionView.id],
      memberCount: 1
    });
    expect(fixture.transaction.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'operation',
          rolePermissions: {
            create: [{ permissionId: permissionView.id, sensitiveApprovalRequired: false }]
          }
        })
      })
    );
    expect(fixture.auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'roles',
        action: 'role.create',
        afterData: expect.objectContaining({
          permissionCodes: ['apple.order.view']
        })
      }),
      fixture.transaction
    );
  });

  it('rejects a role without any permission', async () => {
    const fixture = createService();

    await expect(
      fixture.service.create(
        {
          name: '空角色',
          code: 'empty_role',
          permissionIds: []
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores approval-required switches only for selected sensitive permissions', async () => {
    const fixture = createService();
    const created = createRole({
      rolePermissions: [
        {
          roleId: 'role-id',
          permissionId: permissionSensitive.id,
          permission: permissionSensitive,
          sensitiveApprovalRequired: true
        }
      ]
    });
    fixture.prisma.role.findFirst.mockResolvedValue(null);
    fixture.prisma.permission.findMany.mockResolvedValue([
      { id: permissionSensitive.id, code: permissionSensitive.code }
    ]);
    fixture.transaction.role.create.mockResolvedValue(created);

    const result = await fixture.service.create(
      {
        name: '敏感资料审核角色',
        code: 'sensitive_reviewer',
        permissionIds: [permissionSensitive.id],
        sensitiveApprovalPermissionIds: [permissionSensitive.id]
      },
      operator
    );

    expect(result.sensitiveApprovalPermissionIds).toEqual([permissionSensitive.id]);
    expect(fixture.transaction.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rolePermissions: {
            create: [
              {
                permissionId: permissionSensitive.id,
                sensitiveApprovalRequired: true
              }
            ]
          }
        })
      })
    );
  });

  it('rejects inline full display for passwords and security information', async () => {
    const fixture = createService();
    fixture.prisma.permission.findMany.mockResolvedValue([
      { id: permissionSensitive.id, code: permissionSensitive.code }
    ]);

    await expect(
      fixture.service.create(
        {
          name: '不安全角色',
          code: 'unsafe_secret_role',
          permissionIds: [permissionSensitive.id],
          sensitiveDisplayPolicies: [
            {
              fieldKey: 'account.password',
              context: 'account_management',
              mode: 'full'
            }
          ]
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.transaction.role.create).not.toHaveBeenCalled();
  });

  it('rejects full sensitive values in audit logs even when submitted outside the UI', async () => {
    const fixture = createService();
    fixture.prisma.permission.findMany.mockResolvedValue([
      { id: permissionAppleId.id, code: permissionAppleId.code }
    ]);

    await expect(
      fixture.service.create(
        {
          name: '不安全审计角色',
          code: 'unsafe_audit_role',
          permissionIds: [permissionAppleId.id],
          sensitiveDisplayPolicies: [
            {
              fieldKey: 'account.apple_id',
              context: 'audit',
              mode: 'full'
            }
          ]
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.transaction.role.create).not.toHaveBeenCalled();
  });

  it('protects the system administrator role from changes', async () => {
    const fixture = createService();
    fixture.prisma.role.findUnique.mockResolvedValue(
      createRole({
        name: '管理员',
        code: 'admin'
      })
    );

    await expect(
      fixture.service.update(
        '22222222-2222-4222-8222-222222222222',
        {
          name: '其他名称'
        },
        operator
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns every catalog permission for the system administrator role', async () => {
    const fixture = createService();
    fixture.prisma.role.findUnique.mockResolvedValue(
      createRole({
        name: '管理员',
        code: 'admin'
      })
    );
    fixture.prisma.permission.findMany.mockResolvedValue([permissionView, permissionUpdate]);

    const result = await fixture.service.get('22222222-2222-4222-8222-222222222222');

    expect(result).toMatchObject({
      code: 'admin',
      isSystemRole: true,
      permissionCount: 2,
      permissionIds: [permissionView.id, permissionUpdate.id]
    });
  });

  it('keeps custom role permissions scoped to assigned permissions', async () => {
    const fixture = createService();
    fixture.prisma.role.findUnique.mockResolvedValue(createRole());
    fixture.prisma.permission.findMany.mockResolvedValue([permissionView, permissionUpdate]);

    const result = await fixture.service.get('22222222-2222-4222-8222-222222222222');

    expect(result).toMatchObject({
      code: 'operation',
      permissionCount: 1,
      permissionIds: [permissionView.id]
    });
  });

  it('replaces permissions atomically, audits the diff and invalidates assigned users', async () => {
    const fixture = createService();
    const existing = createRole();
    const updated = createRole({
      name: '高级运营',
      updatedAt: new Date('2026-07-30T09:00:00.000Z'),
      rolePermissions: [
        {
          roleId: 'role-id',
          permissionId: permissionUpdate.id,
          permission: permissionUpdate
        }
      ]
    });
    fixture.prisma.role.findUnique.mockResolvedValue(existing);
    fixture.prisma.permission.findMany.mockResolvedValue([
      {
        id: permissionUpdate.id,
        code: permissionUpdate.code
      }
    ]);
    fixture.transaction.role.update.mockResolvedValue(updated);

    const result = await fixture.service.update(
      existing.id,
      {
        name: '高级运营',
        permissionIds: [permissionUpdate.id]
      },
      operator
    );

    expect(result.permissionIds).toEqual([permissionUpdate.id]);
    expect(fixture.transaction.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: {
        roleId: existing.id
      }
    });
    expect(fixture.transaction.rolePermission.createMany).toHaveBeenCalledWith({
      data: [
        {
          roleId: existing.id,
          permissionId: permissionUpdate.id,
          sensitiveApprovalRequired: false
        }
      ]
    });
    expect(fixture.auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.update',
        beforeData: expect.objectContaining({
          permissionCodes: ['apple.order.view']
        }),
        afterData: expect.objectContaining({
          permissionCodes: ['apple.order.update']
        })
      }),
      fixture.transaction
    );
    expect(fixture.identityService.invalidateAuthenticatedUser).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555'
    );
  });
});
