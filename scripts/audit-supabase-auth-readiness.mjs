#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DETAIL_LIMIT = 500;
const SMOKE_USERNAME = 'production_release_smoke';
const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
const supabaseServiceKey =
  process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('认证就绪审计需要 SUPABASE_URL 和 Supabase service/secret key');
}
const detailsOutputIndex = process.argv.indexOf('--details-output');
if (detailsOutputIndex >= 0 && !process.argv[detailsOutputIndex + 1]) {
  throw new Error('--details-output 必须指定本地输出文件');
}
const detailsOutputPath =
  detailsOutputIndex >= 0 && process.argv[detailsOutputIndex + 1]
    ? path.resolve(process.argv[detailsOutputIndex + 1])
    : null;
const prisma = new PrismaClient();
const historicalResetFlagWhere = {
  enabled: true,
  mustResetPassword: false,
  usernameNormalized: {
    not: SMOKE_USERNAME
  },
  user: {
    status: 'active',
    deletedAt: null,
    auditLogs: {
      none: {
        module: 'auth',
        action: 'change_password'
      }
    }
  }
};

try {
  const now = new Date();
  const [
    activeUserCount,
    identityCount,
    missingIdentityCount,
    missingIdentityRows,
    resetFlagCandidateCount,
    resetFlagCandidateRows,
    inactiveIdentityCount,
    cleanupEligibleSessionCount,
    currentActiveSessionCount,
    enabledIdentityRows
  ] = await Promise.all([
    prisma.user.count({
      where: { status: 'active', deletedAt: null }
    }),
    prisma.v2AuthIdentity.count(),
    prisma.user.count({
      where: {
        status: 'active',
        deletedAt: null,
        v2AuthIdentity: { is: null }
      }
    }),
    prisma.user.findMany({
      where: {
        status: 'active',
        deletedAt: null,
        v2AuthIdentity: { is: null }
      },
      select: {
        id: true,
        username: true
      },
      orderBy: { username: 'asc' },
      take: DETAIL_LIMIT
    }),
    prisma.v2AuthIdentity.count({
      where: historicalResetFlagWhere
    }),
    prisma.v2AuthIdentity.findMany({
      where: historicalResetFlagWhere,
      select: {
        userId: true,
        lastAuthenticatedAt: true,
        updatedAt: true,
        user: {
          select: {
            username: true
          }
        }
      },
      orderBy: { updatedAt: 'asc' },
      take: DETAIL_LIMIT
    }),
    prisma.v2AuthIdentity.count({
      where: {
        enabled: true,
        OR: [
          {
            user: {
              status: { not: 'active' }
            }
          },
          {
            user: {
              deletedAt: { not: null }
            }
          }
        ]
      }
    }),
    prisma.activeSession.count({
      where: {
        OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }]
      }
    }),
    prisma.activeSession.count({
      where: {
        revokedAt: null,
        expiresAt: { gt: now }
      }
    }),
    prisma.v2AuthIdentity.findMany({
      where: {
        enabled: true
      },
      select: {
        authEmail: true,
        authUserId: true,
        usernameNormalized: true,
        userId: true
      }
    })
  ]);
  const providerUsers = await listProviderUsers();
  const providerUsersById = new Map(providerUsers.map((user) => [user.id, user]));
  const missingProviderIdentities = enabledIdentityRows.filter(
    (identity) => !providerUsersById.has(identity.authUserId)
  );
  const providerEmailMismatches = enabledIdentityRows.filter((identity) => {
    const providerUser = providerUsersById.get(identity.authUserId);
    return (
      providerUser && providerUser.email?.trim().toLowerCase() !== identity.authEmail.toLowerCase()
    );
  });
  const identitiesMissingVerifiedTotp = enabledIdentityRows.filter((identity) => {
    const providerUser = providerUsersById.get(identity.authUserId);
    return providerUser && providerUser.verifiedTotpFactorCount === 0;
  });
  const smokeIdentitiesWithAmbiguousTotp = enabledIdentityRows.filter((identity) => {
    const providerUser = providerUsersById.get(identity.authUserId);
    return (
      identity.usernameNormalized === SMOKE_USERNAME &&
      providerUser &&
      providerUser.verifiedTotpFactorCount > 0 &&
      (providerUser.verifiedTotpFactorCount !== 1 || providerUser.totpFactorCount !== 1)
    );
  });
  const blockingIssueCount =
    missingIdentityCount +
    resetFlagCandidateCount +
    inactiveIdentityCount +
    missingProviderIdentities.length +
    providerEmailMismatches.length +
    identitiesMissingVerifiedTotp.length +
    smokeIdentitiesWithAmbiguousTotp.length;
  const detailsTruncated =
    missingIdentityCount > DETAIL_LIMIT ||
    resetFlagCandidateCount > DETAIL_LIMIT ||
    identitiesMissingVerifiedTotp.length > DETAIL_LIMIT ||
    smokeIdentitiesWithAmbiguousTotp.length > DETAIL_LIMIT;

  const summaryReport = {
    generatedAt: now.toISOString(),
    readOnly: true,
    readyForAutomaticRelease: blockingIssueCount === 0,
    blockingIssueCount,
    detailsTruncated,
    summary: {
      activeUserCount,
      identityCount,
      activeUsersMissingIdentity: missingIdentityCount,
      historicalResetFlagCandidates: resetFlagCandidateCount,
      enabledIdentitiesForInactiveUsers: inactiveIdentityCount,
      providerAuthUsersScanned: providerUsers.length,
      enabledIdentitiesMissingProviderUser: missingProviderIdentities.length,
      providerEmailMismatches: providerEmailMismatches.length,
      enabledIdentitiesMissingVerifiedTotp: identitiesMissingVerifiedTotp.length,
      smokeIdentitiesWithAmbiguousTotp: smokeIdentitiesWithAmbiguousTotp.length,
      currentActiveSessions: currentActiveSessionCount,
      cleanupEligibleSessions: cleanupEligibleSessionCount
    },
    detailsAvailable:
      missingIdentityCount > 0 ||
      resetFlagCandidateCount > 0 ||
      missingProviderIdentities.length > 0 ||
      providerEmailMismatches.length > 0 ||
      identitiesMissingVerifiedTotp.length > 0 ||
      smokeIdentitiesWithAmbiguousTotp.length > 0 ||
      missingIdentityCount > DETAIL_LIMIT ||
      resetFlagCandidateCount > DETAIL_LIMIT ||
      identitiesMissingVerifiedTotp.length > DETAIL_LIMIT ||
      smokeIdentitiesWithAmbiguousTotp.length > DETAIL_LIMIT,
    detailsWritten: Boolean(detailsOutputPath),
    guidance: [
      '该命令不会修改数据。',
      '历史版本曾在登录成功时直接清除 mustResetPassword；无 change_password 审计的候选账号必须逐个确认。',
      '已记录 change_password 审计的账号和固定只读巡检账号不列为历史候选。',
      '只能对确认仍使用临时密码的 userId 定向恢复标记，禁止全表 UPDATE。',
      '生产启用的每个身份必须在对应 Supabase Auth 用户上绑定至少一个 verified TOTP factor。',
      '固定生产巡检账号必须且只能绑定一个 TOTP factor，并且该 factor 必须为 verified。',
      'cleanupEligibleSessions 仅用于规划分批保留期清理，不代表可以直接清空。',
      '账号明细默认不写入 stdout；需要复核时使用 --details-output 写入权限为 0600 的本地文件。'
    ]
  };
  const detailsReport = {
    ...summaryReport,
    review: {
      activeUsersMissingIdentity: missingIdentityRows,
      historicalResetFlagCandidates: resetFlagCandidateRows.map((identity) => ({
        userId: identity.userId,
        username: identity.user.username,
        lastAuthenticatedAt: identity.lastAuthenticatedAt?.toISOString() ?? null,
        identityUpdatedAt: identity.updatedAt.toISOString()
      })),
      enabledIdentitiesMissingProviderUser: missingProviderIdentities
        .slice(0, DETAIL_LIMIT)
        .map((identity) => ({
          authUserId: identity.authUserId,
          userId: identity.userId
        })),
      providerEmailMismatches: providerEmailMismatches.slice(0, DETAIL_LIMIT).map((identity) => ({
        authUserId: identity.authUserId,
        userId: identity.userId
      })),
      enabledIdentitiesMissingVerifiedTotp: identitiesMissingVerifiedTotp
        .slice(0, DETAIL_LIMIT)
        .map((identity) => ({
          authUserId: identity.authUserId,
          userId: identity.userId
        })),
      smokeIdentitiesWithAmbiguousTotp: smokeIdentitiesWithAmbiguousTotp
        .slice(0, DETAIL_LIMIT)
        .map((identity) => ({
          authUserId: identity.authUserId,
          userId: identity.userId
        })),
      detailsTruncated
    }
  };

  if (detailsOutputPath) {
    await writeFile(detailsOutputPath, `${JSON.stringify(detailsReport, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await chmod(detailsOutputPath, 0o600);
  }
  process.stdout.write(`${JSON.stringify(summaryReport, null, 2)}\n`);
  if (!summaryReport.readyForAutomaticRelease) {
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}

async function listProviderUsers() {
  const users = [];
  const seenIds = new Set();
  const perPage = 1_000;
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      {
        headers: {
          apikey: supabaseServiceKey,
          authorization: `Bearer ${supabaseServiceKey}`
        },
        signal: AbortSignal.timeout(15_000)
      }
    );
    if (!response.ok) {
      throw new Error(`Supabase Admin 用户核验失败，HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.users)) {
      throw new Error('Supabase Admin 用户核验返回格式无效');
    }
    for (const user of payload.users) {
      if (typeof user?.id !== 'string' || seenIds.has(user.id)) {
        throw new Error('Supabase Admin 用户核验包含无效或重复 user id');
      }
      seenIds.add(user.id);
      users.push({
        id: user.id,
        email: typeof user.email === 'string' ? user.email : null,
        verifiedTotpFactorCount: Array.isArray(user.factors)
          ? user.factors.filter(
              (factor) => factor?.factor_type === 'totp' && factor?.status === 'verified'
            ).length
          : 0,
        totpFactorCount: Array.isArray(user.factors)
          ? user.factors.filter((factor) => factor?.factor_type === 'totp').length
          : 0
      });
    }
    if (payload.users.length < perPage) return users;
  }
  throw new Error('Supabase Admin 用户超过安全分页上限，审计未完成');
}
