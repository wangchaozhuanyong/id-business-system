import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password-hasher';

const prisma = new PrismaClient();

const permissions = [
  ['查看 ID', 'apple.account.view'],
  ['新增 ID', 'apple.account.create'],
  ['导入 ID', 'apple.account.import'],
  ['修改 ID', 'apple.account.update'],
  ['删除 ID', 'apple.account.delete'],
  ['查看完整 ID', 'apple.account.view_full'],
  ['查看 ID 密码', 'apple.secret.view_password'],
  ['查看 ID 手机号', 'apple.secret.view_phone'],
  ['查看 ID 密保', 'apple.secret.view_security'],
  ['查看余额', 'apple.balance.view'],
  ['余额入账', 'apple.balance.topup'],
  ['调整余额', 'apple.balance.adjust'],
  ['查看加卡供应商资金', 'apple.topup_supplier_fund.view'],
  ['管理加卡供应商资金', 'apple.topup_supplier_fund.manage'],
  ['查看完整礼品卡号', 'apple.gift_card.view_full'],
  ['查看订单', 'apple.order.view'],
  ['新增订单', 'apple.order.create'],
  ['修改订单', 'apple.order.update'],
  ['删除订单', 'apple.order.delete'],
  ['查看开通记录', 'apple.activation.view'],
  ['查看续费', 'apple.renewal_task.view'],
  ['执行续费', 'apple.renewal_task.update'],
  ['查看汇率', 'apple.exchange_rate.view'],
  ['录入汇率', 'apple.exchange_rate.create'],
  ['采集汇率', 'apple.exchange_rate.collect'],
  ['管理汇率设置', 'apple.exchange_rate.manage'],
  ['查看客户', 'customer.view'],
  ['新增客户', 'customer.create'],
  ['修改客户', 'customer.update'],
  ['删除客户', 'customer.delete'],
  ['查看客户手机号', 'customer.view_phone'],
  ['管理业务选项', 'data.dictionary.manage'],
  ['查看审计日志', 'audit_log.view'],
  ['管理续费预警', 'id_business_v2.renewal_warning.manage'],
  ['查看经营分析', 'data.analytics.view'],
  ['查看财务', 'finance.view'],
  ['财务记账', 'finance.post'],
  ['财务调整', 'finance.adjust'],
  ['管理财务', 'finance.manage'],
  ['财务关账', 'finance.close']
] as const;

async function main() {
  const adminUsername = process.env.SEED_ADMIN_USERNAME?.trim();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  const resetPassword = process.env.SEED_ADMIN_RESET_PASSWORD === 'true';

  if (!adminUsername || !adminPassword) {
    throw new Error('初始化需要配置 SEED_ADMIN_USERNAME 和 SEED_ADMIN_PASSWORD');
  }

  const adminRole = await prisma.role.upsert({
    where: { code: 'admin' },
    update: {
      name: '管理员',
      description: 'ID 业务管理系统管理员'
    },
    create: {
      name: '管理员',
      code: 'admin',
      description: 'ID 业务管理系统管理员'
    }
  });

  const permissionRecords = await Promise.all(
    permissions.map(([name, code]) => {
      const parts = code.split('.');
      const action = parts.pop()!;
      return prisma.permission.upsert({
        where: { code },
        update: {
          name,
          module: parts.join('.'),
          action
        },
        create: {
          name,
          code,
          module: parts.join('.'),
          action
        }
      });
    })
  );

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({
      where: {
        roleId: adminRole.id
      }
    }),
    ...permissionRecords.map((permission) =>
      prisma.rolePermission.create({
        data: {
          roleId: adminRole.id,
          permissionId: permission.id
        }
      })
    )
  ]);

  const existingAdmin = await prisma.user.findUnique({
    where: { username: adminUsername },
    select: { id: true }
  });
  const passwordHash = await hashPassword(adminPassword);
  const adminUser = existingAdmin
    ? await prisma.user.update({
        where: { id: existingAdmin.id },
        data: {
          ...(resetPassword ? { passwordHash } : {}),
          displayName: process.env.SEED_ADMIN_DISPLAY_NAME?.trim() || '管理员',
          status: 'active',
          deletedAt: null
        }
      })
    : await prisma.user.create({
        data: {
          username: adminUsername,
          passwordHash,
          displayName: process.env.SEED_ADMIN_DISPLAY_NAME?.trim() || '管理员',
          status: 'active'
        }
      });

  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: adminUser.id,
        roleId: adminRole.id
      }
    },
    update: {},
    create: {
      userId: adminUser.id,
      roleId: adminRole.id
    }
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
