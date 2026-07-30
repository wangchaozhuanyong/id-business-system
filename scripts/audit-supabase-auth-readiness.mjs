#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import process from 'node:process';

const DETAIL_LIMIT = 500;
const SMOKE_USERNAME = 'production_release_smoke';
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
    currentActiveSessionCount
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
    })
  ]);

  const report = {
    generatedAt: now.toISOString(),
    readOnly: true,
    readyForAutomaticRelease:
      missingIdentityCount === 0 && resetFlagCandidateCount === 0 && inactiveIdentityCount === 0,
    summary: {
      activeUserCount,
      identityCount,
      activeUsersMissingIdentity: missingIdentityCount,
      historicalResetFlagCandidates: resetFlagCandidateCount,
      enabledIdentitiesForInactiveUsers: inactiveIdentityCount,
      currentActiveSessions: currentActiveSessionCount,
      cleanupEligibleSessions: cleanupEligibleSessionCount
    },
    review: {
      activeUsersMissingIdentity: missingIdentityRows,
      historicalResetFlagCandidates: resetFlagCandidateRows.map((identity) => ({
        userId: identity.userId,
        username: identity.user.username,
        lastAuthenticatedAt: identity.lastAuthenticatedAt?.toISOString() ?? null,
        identityUpdatedAt: identity.updatedAt.toISOString()
      })),
      detailsTruncated:
        missingIdentityCount > DETAIL_LIMIT || resetFlagCandidateCount > DETAIL_LIMIT
    },
    guidance: [
      '该命令不会修改数据。',
      '历史版本曾在登录成功时直接清除 mustResetPassword；无 change_password 审计的候选账号必须逐个确认。',
      '已记录 change_password 审计的账号和固定只读巡检账号不列为历史候选。',
      '只能对确认仍使用临时密码的 userId 定向恢复标记，禁止全表 UPDATE。',
      'cleanupEligibleSessions 仅用于规划分批保留期清理，不代表可以直接清空。'
    ]
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.readyForAutomaticRelease) {
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}
