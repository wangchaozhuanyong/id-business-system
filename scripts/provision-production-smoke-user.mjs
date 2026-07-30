#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import process from 'node:process';
import {
  SMOKE_AUTH_ACTOR,
  SMOKE_AUTH_EMAIL,
  SMOKE_DISPLAY_NAME,
  SMOKE_PERMISSIONS,
  SMOKE_ROLE_CODE,
  SMOKE_ROLE_DESCRIPTION,
  SMOKE_ROLE_NAME,
  SMOKE_USERNAME
} from './lib/cloudflare-release.mjs';
import {
  SmokeProvisioningSafetyError,
  assertDedicatedSmokeBusinessUsers,
  assertDedicatedSmokeIdentity,
  assertDedicatedSmokeRole,
  assertDedicatedSupabaseAuthUser,
  assertSmokeProvisioningEnvironment
} from './lib/smoke-user-provisioning.mjs';

const config = assertSmokeProvisioningEnvironment(process.env);
const { hashPassword } = await import('../apps/api/dist/auth/password-hasher.js');
const passwordHash = await hashPassword(config.password);
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

class SmokeProvisioningRetryableError extends Error {}

let authUser = null;
let authUserCreated = false;

try {
  let initialState;
  try {
    initialState = await loadDatabaseState(prisma);
  } catch {
    throw new SmokeProvisioningRetryableError(
      '巡检账号数据库预检失败；未执行账号修改，请修复连接后重试 provisioning'
    );
  }
  assertDedicatedSmokeBusinessUsers(initialState.users);
  assertDedicatedSmokeRole(initialState.role);

  let supabase = null;
  if (config.authProvider === 'supabase') {
    supabase = createSupabaseAdminClient(config);
    const authState = await ensureSupabaseAuthUser(supabase, config.password);
    authUser = authState.user;
    authUserCreated = authState.created;
  }

  let result;
  try {
    result = await synchronizeDatabase(prisma, {
      authUser,
      passwordHash
    });
  } catch (error) {
    if (authUserCreated && authUser && supabase) {
      const compensated = await deleteSupabaseAuthUser(supabase, authUser.id);
      if (!compensated) {
        throw new SmokeProvisioningRetryableError(
          '数据库同步失败，且新建 Supabase 巡检用户补偿删除失败；请使用同一凭据重试 provisioning'
        );
      }
    }
    if (error instanceof SmokeProvisioningSafetyError) throw error;
    throw new SmokeProvisioningRetryableError(
      '巡检账号数据库同步失败；未输出敏感数据，请修复后重试 provisioning'
    );
  }

  if (config.authProvider === 'supabase' && !authUserCreated) {
    const rotated = await updateSupabasePassword(supabase, authUser.id, config.password);
    if (!rotated) {
      throw new SmokeProvisioningRetryableError(
        '巡检账号数据库已同步，但 Supabase 密码轮换结果不确定；请使用同一凭据重试 provisioning'
      );
    }
  }

  try {
    await prisma.auditLog.create({
      data: {
        module: 'release',
        action: result.existed ? 'refresh_smoke_user' : 'create_smoke_user',
        objectType: 'user',
        objectId: result.userId,
        beforeData: {
          existed: result.existed,
          roleCodes: result.previousRoleCodes
        },
        afterData: {
          authProvider: config.authProvider,
          authIdentitySynchronized: Boolean(authUser),
          roleCode: SMOKE_ROLE_CODE,
          permissionCodes: SMOKE_PERMISSIONS
        },
        remark: 'Provisioned the dedicated production release read-only smoke account'
      }
    });
  } catch {
    throw new SmokeProvisioningRetryableError(
      '巡检账号已同步，但审计记录写入失败；请使用同一凭据重试 provisioning 以补齐审计'
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        authProvider: config.authProvider,
        authUserCreated,
        userId: result.userId,
        roleCode: result.roleCode,
        permissionCount: result.permissionCount
      },
      null,
      2
    )
  );
} catch (error) {
  if (
    error instanceof SmokeProvisioningSafetyError ||
    error instanceof SmokeProvisioningRetryableError
  ) {
    throw error;
  }
  // eslint-disable-next-line preserve-caught-error -- Provisioning errors may contain credential-bearing request context.
  throw new Error('巡检账号 provisioning 失败；错误详情已脱敏，请修复后重试');
} finally {
  await prisma.$disconnect();
}

async function loadDatabaseState(client) {
  const [users, role] = await Promise.all([
    client.user.findMany({
      where: {
        OR: [
          {
            username: {
              equals: SMOKE_USERNAME,
              mode: 'insensitive'
            }
          },
          {
            email: {
              equals: SMOKE_AUTH_EMAIL,
              mode: 'insensitive'
            }
          }
        ]
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        userRoles: {
          select: {
            role: {
              select: {
                code: true
              }
            }
          }
        }
      }
    }),
    client.role.findUnique({
      where: {
        code: SMOKE_ROLE_CODE
      },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        userRoles: {
          select: {
            user: {
              select: {
                username: true
              }
            }
          }
        }
      }
    })
  ]);

  return { role, users };
}

async function synchronizeDatabase(client, { authUser: managedAuthUser, passwordHash: nextHash }) {
  return client.$transaction(
    async (transaction) => {
      const state = await loadDatabaseState(transaction);
      const existingUser = assertDedicatedSmokeBusinessUsers(state.users);
      assertDedicatedSmokeRole(state.role);

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
            update: {},
            create: {
              ...data,
              code
            }
          });
        })
      );

      const role =
        state.role ??
        (await transaction.role.create({
          data: {
            name: SMOKE_ROLE_NAME,
            code: SMOKE_ROLE_CODE,
            description: SMOKE_ROLE_DESCRIPTION
          }
        }));

      const user = existingUser
        ? await transaction.user.update({
            where: { id: existingUser.id },
            data: {
              passwordHash: nextHash,
              displayName: SMOKE_DISPLAY_NAME,
              email: SMOKE_AUTH_EMAIL,
              status: 'active',
              deletedAt: null
            }
          })
        : await transaction.user.create({
            data: {
              username: SMOKE_USERNAME,
              passwordHash: nextHash,
              displayName: SMOKE_DISPLAY_NAME,
              email: SMOKE_AUTH_EMAIL,
              status: 'active'
            }
          });

      await transaction.rolePermission.deleteMany({
        where: {
          roleId: role.id,
          permissionId: {
            notIn: permissions.map((permission) => permission.id)
          }
        }
      });
      await transaction.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id
        })),
        skipDuplicates: true
      });
      await transaction.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: role.id
          }
        },
        update: {},
        create: {
          userId: user.id,
          roleId: role.id
        }
      });

      if (managedAuthUser) {
        const identities = await transaction.v2AuthIdentity.findMany({
          where: {
            OR: [
              { userId: user.id },
              { authUserId: managedAuthUser.id },
              { usernameNormalized: SMOKE_USERNAME },
              {
                authEmail: {
                  equals: SMOKE_AUTH_EMAIL,
                  mode: 'insensitive'
                }
              }
            ]
          },
          select: {
            id: true,
            userId: true,
            authUserId: true,
            usernameNormalized: true,
            authEmail: true
          }
        });
        if (identities.length > 1) {
          throw new SmokeProvisioningSafetyError('固定巡检身份标识命中了多条绑定，已拒绝修改');
        }
        assertDedicatedSmokeIdentity(identities[0] ?? null, {
          userId: user.id,
          authUserId: managedAuthUser.id
        });
        await transaction.v2AuthIdentity.upsert({
          where: {
            userId: user.id
          },
          update: {
            authUserId: managedAuthUser.id,
            usernameNormalized: SMOKE_USERNAME,
            authEmail: SMOKE_AUTH_EMAIL,
            enabled: true,
            mustResetPassword: false
          },
          create: {
            authUserId: managedAuthUser.id,
            userId: user.id,
            usernameNormalized: SMOKE_USERNAME,
            authEmail: SMOKE_AUTH_EMAIL,
            enabled: true,
            mustResetPassword: false
          }
        });
      }

      return {
        existed: Boolean(existingUser),
        previousRoleCodes: existingUser?.userRoles.map((assignment) => assignment.role.code) ?? [],
        userId: user.id,
        roleCode: role.code,
        permissionCount: permissions.length
      };
    },
    {
      isolationLevel: 'Serializable'
    }
  );
}

function createSupabaseAdminClient({ serviceKey, supabaseUrl }) {
  return createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      fetch: (input, init = {}) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(15_000)
        })
    }
  });
}

async function ensureSupabaseAuthUser(supabase, password) {
  const matches = await listSupabaseUsersByEmail(supabase, SMOKE_AUTH_EMAIL);
  if (matches.length > 1) {
    throw new SmokeProvisioningSafetyError('固定巡检邮箱命中了多个 Supabase Auth 用户，已拒绝修改');
  }
  if (matches.length === 1) {
    assertDedicatedSupabaseAuthUser(matches[0]);
    return { created: false, user: matches[0] };
  }

  let result;
  try {
    result = await supabase.auth.admin.createUser({
      email: SMOKE_AUTH_EMAIL,
      password,
      email_confirm: true,
      app_metadata: {
        id_business_system_actor: SMOKE_AUTH_ACTOR
      },
      user_metadata: {
        display_name: SMOKE_DISPLAY_NAME,
        username: SMOKE_USERNAME
      }
    });
  } catch {
    throw new SmokeProvisioningRetryableError(
      'Supabase 巡检用户创建结果不确定；请确认固定邮箱状态后使用同一凭据重试'
    );
  }
  if (result.error || !result.data.user) {
    throw new SmokeProvisioningRetryableError(
      'Supabase 巡检用户创建失败或结果不确定；请确认固定邮箱状态后使用同一凭据重试'
    );
  }
  try {
    assertDedicatedSupabaseAuthUser(result.data.user);
  } catch {
    const compensated = await deleteSupabaseAuthUser(supabase, result.data.user.id);
    if (!compensated) {
      throw new SmokeProvisioningRetryableError(
        'Supabase 巡检用户创建结果缺少专用标记，且补偿删除失败；请使用同一凭据重试'
      );
    }
    throw new SmokeProvisioningRetryableError(
      'Supabase 巡检用户创建结果缺少专用标记，已补偿删除；请重试 provisioning'
    );
  }
  return { created: true, user: result.data.user };
}

async function listSupabaseUsersByEmail(supabase, email) {
  const matches = [];
  const perPage = 1000;
  for (let page = 1; page <= 1000; page += 1) {
    let result;
    try {
      result = await supabase.auth.admin.listUsers({ page, perPage });
    } catch {
      throw new SmokeProvisioningRetryableError(
        'Supabase Auth 用户清单读取结果不确定；未执行账号修改，请稍后重试'
      );
    }
    if (result.error) {
      throw new SmokeProvisioningRetryableError(
        'Supabase Auth 用户清单读取失败；未执行账号修改，请稍后重试'
      );
    }
    matches.push(
      ...result.data.users.filter(
        (user) => user.email?.trim().toLowerCase() === email.toLowerCase()
      )
    );
    if (
      result.data.users.length < perPage ||
      (result.data.lastPage > 0 && page >= result.data.lastPage)
    ) {
      return matches;
    }
  }
  throw new SmokeProvisioningRetryableError(
    'Supabase Auth 用户清单分页超出安全上限，未执行账号修改'
  );
}

async function updateSupabasePassword(supabase, authUserId, password) {
  try {
    const result = await supabase.auth.admin.updateUserById(authUserId, { password });
    return !result.error && result.data.user?.id === authUserId;
  } catch {
    return false;
  }
}

async function deleteSupabaseAuthUser(supabase, authUserId) {
  try {
    const result = await supabase.auth.admin.deleteUser(authUserId);
    return !result.error;
  } catch {
    return false;
  }
}
