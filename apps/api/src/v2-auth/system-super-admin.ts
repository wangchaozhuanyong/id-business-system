import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { acquireMysqlTransactionLock } from '../common/prisma/mysql-transaction-lock';
import { bumpV2ScopeVersions } from '../common/prisma/bump-v2-scope-versions';
import type { PrismaService } from '../common/prisma/prisma.service';

export const SYSTEM_SUPER_ADMIN_ROLE = 'super_admin';
export const SYSTEM_SUPER_ADMIN_KEY = 'v2_system_super_admin';
export const EMPLOYEE_TAKEOVER_PREFIX = 'v2_employee_business_takeover_';
const INITIAL_SUPER_ADMIN_USERNAME = 'ppfzj1314';
const USER_ID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
type SettingsClient = Pick<Prisma.TransactionClient, 'securitySetting'>;

function readUserId(value: Prisma.JsonValue): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const userId = value.userId;
  return typeof userId === 'string' && USER_ID_PATTERN.test(userId) ? userId : null;
}

export async function getSystemSuperAdminUserId(client: SettingsClient) {
  const setting = await client.securitySetting.findUnique({
    where: { key: SYSTEM_SUPER_ADMIN_KEY },
    select: { value: true }
  });
  if (!setting) return null;
  const userId = readUserId(setting.value);
  if (!userId) throw new ServiceUnavailableException('系统超级管理员绑定异常，请联系系统负责人。');
  return userId;
}

// 唯一设置键是唯一事实来源。用户名只用于首次绑定，之后始终按固定用户 ID 判断。
export async function ensureSystemSuperAdmin(
  prisma: Pick<PrismaService, 'securitySetting' | '$transaction'>
) {
  const existing = await getSystemSuperAdminUserId(prisma);
  if (existing) return existing;
  return prisma.$transaction(async (tx) => {
    await acquireMysqlTransactionLock(tx, SYSTEM_SUPER_ADMIN_KEY);
    const registered = await getSystemSuperAdminUserId(tx);
    if (registered) return registered;
    const account = await tx.user.findUnique({
      where: { username: INITIAL_SUPER_ADMIN_USERNAME },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        v2AuthIdentity: { select: { enabled: true } }
      }
    });
    if (
      !account ||
      account.status !== 'active' ||
      account.deletedAt ||
      !account.v2AuthIdentity?.enabled
    ) {
      return null;
    }
    const adminRole = await tx.role.findUnique({ where: { code: 'admin' }, select: { id: true } });
    if (!adminRole) return null;
    await tx.userRole.upsert({
      where: { userId_roleId: { userId: account.id, roleId: adminRole.id } },
      create: { userId: account.id, roleId: adminRole.id },
      update: {}
    });
    await tx.securitySetting.create({
      data: {
        key: SYSTEM_SUPER_ADMIN_KEY,
        value: { userId: account.id },
        remark: '唯一系统超级管理员固定身份绑定',
        updatedByUserId: account.id
      }
    });
    await tx.auditLog.create({
      data: {
        userId: account.id,
        module: 'employees',
        action: 'system_super_admin.initialize',
        objectType: 'user',
        objectId: account.id,
        afterData: { userId: account.id },
        remark: '首次绑定唯一系统超级管理员'
      }
    });
    await bumpV2ScopeVersions(tx, ['employees', 'security']);
    return account.id;
  });
}

export async function requireSystemSuperAdmin(
  client: SettingsClient & Pick<Prisma.TransactionClient, 'user'>,
  userId: string
) {
  const ownerId = await getSystemSuperAdminUserId(client);
  if (!ownerId || ownerId !== userId)
    throw new ForbiddenException('仅系统超级管理员可执行此操作。');
  const account = await client.user.findUnique({
    where: { id: ownerId },
    select: { status: true, deletedAt: true }
  });
  if (!account || account.status !== 'active' || account.deletedAt)
    throw new ForbiddenException('超级管理员账号不可用。');
  return ownerId;
}

export async function getEmployeeBusinessOwnerIds(client: SettingsClient, userId: string) {
  if ((await getSystemSuperAdminUserId(client)) !== userId) return [userId];
  const settings = await client.securitySetting.findMany({
    where: { key: { startsWith: EMPLOYEE_TAKEOVER_PREFIX } },
    select: { key: true, value: true }
  });
  return [
    ...new Set([
      userId,
      ...settings.flatMap(({ key, value }) => {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.targetUserId !== userId
        )
          return [];
        const sourceId = key.slice(EMPLOYEE_TAKEOVER_PREFIX.length);
        return USER_ID_PATTERN.test(sourceId) && value.sourceUserId === sourceId ? [sourceId] : [];
      })
    ])
  ];
}

export async function assertEmployeeBusinessWriter(
  client: Prisma.TransactionClient,
  userId: string
) {
  await acquireMysqlTransactionLock(client, 'auto-recharge-single-worker');
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true, deletedAt: true }
  });
  if (!user || user.status !== 'active' || user.deletedAt)
    throw new ForbiddenException('员工账号已停用或删除，不能新增或修改业务。');
}
