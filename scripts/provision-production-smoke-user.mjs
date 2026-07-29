#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import process from 'node:process';
import { SMOKE_PERMISSIONS, SMOKE_ROLE_CODE } from './lib/cloudflare-release.mjs';

const username = process.env.SMOKE_TEST_USERNAME?.trim();
const password = process.env.SMOKE_TEST_PASSWORD;
if (!username || !password) {
  throw new Error('缺少 SMOKE_TEST_USERNAME 或 SMOKE_TEST_PASSWORD');
}

const { hashPassword } = await import('../apps/api/dist/auth/password-hasher.js');
const passwordHash = await hashPassword(password);
const prisma = new PrismaClient();
const permissionNames = new Map([
  ['apple.order.view', '查看订单'],
  ['apple.renewal_task.view', '查看续费'],
  ['apple.account.view', '查看 ID'],
  ['customer.view', '查看客户'],
  ['apple.activation.view', '查看开通记录'],
  ['apple.balance.view', '查看余额'],
  ['apple.exchange_rate.view', '查看汇率']
]);

try {
  const existing = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      userRoles: {
        select: {
          role: {
            select: { code: true }
          }
        }
      }
    }
  });

  const result = await prisma.$transaction(async (transaction) => {
    const permissions = await Promise.all(
      SMOKE_PERMISSIONS.map((code) => {
        const parts = code.split('.');
        const action = parts.pop();
        const data = {
          name: permissionNames.get(code),
          module: parts.join('.'),
          action
        };
        return transaction.permission.upsert({
          where: { code },
          update: data,
          create: {
            ...data,
            code
          }
        });
      })
    );
    const role = await transaction.role.upsert({
      where: { code: SMOKE_ROLE_CODE },
      update: {
        name: '生产发布只读巡检',
        description: '仅用于生产发布后的自动只读健康检查'
      },
      create: {
        name: '生产发布只读巡检',
        code: SMOKE_ROLE_CODE,
        description: '仅用于生产发布后的自动只读健康检查'
      }
    });

    await transaction.rolePermission.deleteMany({
      where: { roleId: role.id }
    });
    await transaction.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id
      }))
    });

    const user = await transaction.user.upsert({
      where: { username },
      update: {
        passwordHash,
        displayName: '生产发布只读巡检',
        status: 'active',
        deletedAt: null
      },
      create: {
        username,
        passwordHash,
        displayName: '生产发布只读巡检',
        status: 'active'
      }
    });

    await transaction.userRole.deleteMany({
      where: { userId: user.id }
    });
    await transaction.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id
      }
    });
    await transaction.auditLog.create({
      data: {
        module: 'release',
        action: existing ? 'refresh_smoke_user' : 'create_smoke_user',
        objectType: 'user',
        objectId: user.id,
        beforeData: {
          existed: Boolean(existing),
          roleCodes: existing?.userRoles.map((assignment) => assignment.role.code) ?? []
        },
        afterData: {
          roleCode: SMOKE_ROLE_CODE,
          permissionCodes: SMOKE_PERMISSIONS
        },
        remark: 'Provisioned the production release read-only smoke account'
      }
    });

    return {
      userId: user.id,
      roleCode: role.code,
      permissionCount: permissions.length
    };
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        ...result
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}
