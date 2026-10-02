import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { hashPassword } from '../../auth/password-hasher';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../common/prisma/mysql-transaction-lock';
import { bumpV2ScopeVersions } from '../../common/prisma/bump-v2-scope-versions';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import { SecurityService } from '../../security/security.service';
import { V2IdentityService } from '../v2-identity.service';
import { EMPLOYEE_TAKEOVER_PREFIX, requireSystemSuperAdmin } from '../system-super-admin';

const EMPLOYEE_SELECT = {
  id: true,
  username: true,
  displayName: true,
  status: true,
  deletedAt: true,
  updatedAt: true
} as const;
const CHANGED_SCOPES = ['employees', 'security', 'auto-recharge', 'workspace'] as const;
type Client = Prisma.TransactionClient;
export interface ResetV2EmployeePasswordDto {
  expectedUpdatedAt: string;
  newPassword: string;
}
export interface DeleteV2EmployeeDto {
  expectedUpdatedAt: string;
  previewHash: string;
}

function normalizeId(id: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))
    throw new BadRequestException('员工标识不正确。');
  return id;
}
function readVersion(value: string) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()))
    throw new BadRequestException('缺少有效的员工资料版本，请刷新后重试。');
  return date;
}

function jsonRecord(value: Prisma.JsonValue): Prisma.JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function hasUnknownPayment(value: Prisma.JsonValue) {
  const document = jsonRecord(value);
  return Boolean(
    document &&
    document.operator_resolution !== 'confirmed_no_bank_request' &&
    (document.payment_status === 'unknown' || document.status === 'payment_result_unknown') &&
    (document.payment_attempted === true ||
      Number(document.confirmation_requests_sent ?? 0) > 0 ||
      Number(document.payment_requests_sent ?? 0) > 0)
  );
}

@Injectable()
export class V2EmployeeAccountActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly security: SecurityService,
    private readonly identity: V2IdentityService,
    private readonly events: V2ChangeEventPublisher
  ) {}

  private async target(client: Client, id: string, operator: AuthenticatedUser) {
    const ownerId = await requireSystemSuperAdmin(client, operator.id);
    if (id === ownerId)
      throw new ForbiddenException('系统超级管理员受保护，请在“我的账户”修改自己的密码。');
    const employee = await client.user.findUnique({ where: { id }, select: EMPLOYEE_SELECT });
    if (!employee) throw new NotFoundException('员工账号不存在。');
    return employee;
  }

  private async claim(client: Client, id: string, expectedUpdatedAt: string) {
    const expected = readVersion(expectedUpdatedAt);
    const changed = await client.user.updateMany({
      where: { id, deletedAt: null, updatedAt: expected },
      data: { updatedAt: new Date(Math.max(Date.now(), expected.getTime() + 1)) }
    });
    if (changed.count !== 1) throw new ConflictException('员工资料已变化，请刷新后重试。');
  }

  private invalidate(userId: string) {
    this.identity.invalidateAuthenticatedUser(userId);
    this.security.invalidateActiveSessionCache();
    this.events.publishCommittedChangeBestEffort([...CHANGED_SCOPES]);
  }

  async resetPassword(
    idInput: string,
    dto: ResetV2EmployeePasswordDto,
    operator: AuthenticatedUser
  ) {
    const id = normalizeId(idInput);
    if (!dto || typeof dto.newPassword !== 'string')
      throw new BadRequestException('请输入新的临时密码。');
    await requireSystemSuperAdmin(this.prisma, operator.id);
    await this.security.assertPasswordMeetsPolicy(dto.newPassword);
    const passwordHash = await hashPassword(dto.newPassword);
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireMysqlTransactionLock(tx, `auth-password:${id}`);
      const employee = await this.target(tx, id, operator);
      if (employee.deletedAt) throw new NotFoundException('员工账号已删除。');
      await this.claim(tx, id, dto.expectedUpdatedAt);
      await tx.user.update({ where: { id }, data: { passwordHash } });
      const identity = await tx.v2AuthIdentity.updateMany({
        where: { userId: id },
        data: { mustResetPassword: true }
      });
      if (identity.count !== 1) throw new ConflictException('员工登录身份异常，密码重置未保存。');
      const revoked = await tx.activeSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      await this.audit.create(
        {
          userId: operator.id,
          module: 'employees',
          action: 'employee.reset_password',
          objectType: 'user',
          objectId: id,
          afterData: { mustResetPassword: true, revokedSessionCount: revoked.count },
          remark: '超级管理员重置员工密码并撤销全部旧会话'
        },
        tx
      );
      await bumpV2ScopeVersions(tx, [...CHANGED_SCOPES]);
      return { reset: true, revokedSessionCount: revoked.count };
    });
    this.invalidate(id);
    return result;
  }

  private async preview(client: Client, id: string, operator: AuthenticatedUser) {
    const employee = await this.target(client, id, operator);
    if (employee.deletedAt) throw new NotFoundException('员工账号已删除。');
    const [
      target,
      jobs,
      records,
      addresses,
      customers,
      orders,
      accounts,
      cards,
      registrationJobs,
      businessTotpAccounts,
      relayJobs,
      runningRelayJobs
    ] = await Promise.all([
      client.user.findUnique({
        where: { id: operator.id },
        select: { id: true, username: true, displayName: true, status: true, deletedAt: true }
      }),
      client.idBusinessV2RechargeJob.findMany({
        where: { ownerId: id },
        select: { id: true, state: true, accountKey: true, result: true }
      }),
      client.idBusinessV2RechargeRecord.findMany({
        where: { ownerId: id },
        select: { accountKey: true, document: true }
      }),
      client.idBusinessV2RechargeAddress.count({ where: { ownerId: id } }),
      client.idBusinessV2Customer.count({ where: { createdByUserId: id } }),
      client.idBusinessV2Order.count({ where: { createdByUserId: id } }),
      client.idBusinessV2Account.count({ where: { createdByUserId: id } }),
      client.idBusinessV2GiftCard.count({ where: { createdByUserId: id } }),
      client.idBusinessV2RegistrationJob.count({
        where: { ownerId: id, state: { notIn: ['completed', 'cancelled'] } }
      }),
      client.idBusinessV2TotpAccount.count({ where: { userId: id } }),
      client.idBusinessV2RelayJob.count({ where: { userId: id } }),
      client.idBusinessV2RelayJob.count({
        where: {
          userId: id,
          OR: [
            { runLeaseExpiresAt: { gt: new Date() } },
            { runLeaseId: { not: null }, runLeaseExpiresAt: null }
          ]
        }
      })
    ]);
    if (!target || target.status !== 'active' || target.deletedAt)
      throw new ForbiddenException('超级管理员账号不可用。');
    const pendingJobs = jobs.filter((job) => job.state !== 'finished').length;
    // 任务已经结束也可能仍然付款结果未知；只有同一账号、同一原订单的账本证据可以解除阻断。
    const unknownJobsWithoutLedger = jobs.filter((job) => {
      if (!hasUnknownPayment(job.result)) return false;
      const result = jsonRecord(job.result)!;
      return !records.some((record) => {
        const document = jsonRecord(record.document);
        if (
          !job.accountKey ||
          job.accountKey !== record.accountKey ||
          !document ||
          typeof result.checkout_identifier !== 'string' ||
          !result.checkout_identifier ||
          document.checkout_identifier !== result.checkout_identifier
        )
          return false;
        return (
          hasUnknownPayment(record.document) ||
          document.operator_resolution === 'confirmed_no_bank_request' ||
          ['paid', 'succeeded', 'failed', 'cancelled'].includes(String(document.payment_status))
        );
      });
    }).length;
    const unknownPayments =
      records.filter(({ document }) => hasUnknownPayment(document)).length +
      unknownJobsWithoutLedger;
    const blockers: string[] = [];
    if (registrationJobs)
      blockers.push(`仍有 ${registrationJobs} 个未结束的注册任务，请处理或取消后再删除。`);
    if (pendingJobs) blockers.push(`仍有 ${pendingJobs} 个未结束的充值任务，请处理完成后再删除。`);
    if (runningRelayJobs)
      blockers.push(`仍有 ${runningRelayJobs} 个中转脚本任务正在执行，请等待执行结束后再删除。`);
    if (unknownPayments)
      blockers.push(`仍有 ${unknownPayments} 条付款结果未确认，请核对原订单后再删除。`);
    const counts = {
      addresses,
      rechargeJobs: jobs.length,
      rechargeRecords: records.length,
      customers,
      orders,
      accounts,
      giftCards: cards,
      businessTotpAccounts,
      relayJobs
    };
    const version = employee.updatedAt.toISOString();
    const previewHash = createHash('sha256')
      .update(JSON.stringify({ id, version, targetId: target.id, counts, blockers }))
      .digest('hex');
    return {
      employee,
      target,
      counts,
      blockers,
      canDelete: !blockers.length,
      expectedUpdatedAt: version,
      previewHash
    };
  }

  async deletePreview(idInput: string, operator: AuthenticatedUser) {
    return this.prisma.$transaction((tx) => this.preview(tx, normalizeId(idInput), operator));
  }

  async remove(idInput: string, dto: DeleteV2EmployeeDto, operator: AuthenticatedUser) {
    const id = normalizeId(idInput);
    if (!dto || typeof dto.previewHash !== 'string')
      throw new BadRequestException('请先完成删除预检查。');
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
      const employee = await this.target(tx, id, operator);
      const key = `${EMPLOYEE_TAKEOVER_PREFIX}${id}`;
      if (employee.deletedAt) {
        const takeover = await tx.securitySetting.findUnique({
          where: { key },
          select: { value: true }
        });
        const value = takeover?.value;
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.sourceUserId === id &&
          value.targetUserId === operator.id
        )
          return { deleted: true, alreadyDeleted: true };
        throw new ConflictException('该账号已删除，接管记录需要核对。');
      }
      const impact = await this.preview(tx, id, operator);
      if (
        dto.previewHash !== impact.previewHash ||
        dto.expectedUpdatedAt !== impact.expectedUpdatedAt
      )
        throw new ConflictException('删除影响已变化，请重新查看预检查后再确认。');
      if (!impact.canDelete) throw new ConflictException(impact.blockers.join(' '));
      await this.claim(tx, id, dto.expectedUpdatedAt);
      const deletedAt = new Date();
      await tx.user.update({ where: { id }, data: { status: 'disabled', deletedAt } });
      await tx.v2AuthIdentity.updateMany({ where: { userId: id }, data: { enabled: false } });
      const revoked = await tx.activeSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: deletedAt }
      });
      // 执行记录的 ownerId 表示当前业务管理权；原操作人仍完整保留在不可变审计中。
      await tx.idBusinessV2RechargeJob.updateMany({
        where: { ownerId: id },
        data: { ownerId: operator.id }
      });
      await tx.idBusinessV2RegistrationJob.updateMany({
        where: { ownerId: id },
        data: { ownerId: operator.id }
      });
      await tx.idBusinessV2RechargeRecord.updateMany({
        where: { ownerId: id },
        data: { ownerId: operator.id }
      });
      await tx.idBusinessV2RechargeAddressUse.updateMany({
        where: { ownerId: id },
        data: { ownerId: operator.id }
      });
      // 地址按原账号隔离保留，避免同名街道唯一键冲突或覆盖资料；查询与操作通过接管范围授权。
      await tx.securitySetting.create({
        data: {
          key,
          value: {
            sourceUserId: id,
            targetUserId: operator.id,
            deletedAt: deletedAt.toISOString(),
            counts: impact.counts
          },
          updatedByUserId: operator.id,
          remark: '员工账号软删除后的业务接管凭据'
        }
      });
      await this.audit.create(
        {
          userId: operator.id,
          module: 'employees',
          action: 'employee.delete',
          objectType: 'user',
          objectId: id,
          beforeData: { ...employee, updatedAt: employee.updatedAt.toISOString() },
          afterData: {
            status: 'disabled',
            deletedAt: deletedAt.toISOString(),
            targetUserId: operator.id,
            counts: impact.counts,
            revokedSessionCount: revoked.count
          },
          remark: '软删除员工账号并由超级管理员接管业务，保留原创建人、审计与财务记录'
        },
        tx
      );
      await bumpV2ScopeVersions(tx, [...CHANGED_SCOPES]);
      return { deleted: true, alreadyDeleted: false };
    });
    this.invalidate(id);
    return result;
  }
}
