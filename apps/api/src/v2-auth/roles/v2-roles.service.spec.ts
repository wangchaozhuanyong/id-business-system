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
            create: [{ permissionId: permissionView.id }]
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
          permissionId: permissionUpdate.id
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
