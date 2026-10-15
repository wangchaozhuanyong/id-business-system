import { ConflictException, BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { BankRechargeRegistrationMirrorService } from '../auto-recharge/public-api';
import type { AutoRegistrationService } from './auto-registration.service';
import type { AppleMailboxSyncPayload } from './apple-mailboxes.types';

const privateBase = '/internal/apple-mailboxes';

/** Replays only persisted facts, with one in-flight mirror per original task. */
export class AppleMailboxMainSync {
  private readonly syncing = new Map<
    string,
    Promise<{ accountId: string | null; syncStatus: 'saved' | 'failed' | 'conflict' }>
  >();
  constructor(
    private readonly worker: AutoRegistrationService,
    private readonly accounts: BankRechargeRegistrationMirrorService,
    private readonly audit: AuditLogsService
  ) {}

  async sync(taskUuid: string, operator: AuthenticatedUser) {
    this.uuid(taskUuid);
    await this.log(operator, '补存隐藏邮箱主账号', taskUuid);
    await this.worker.appleMailboxRequest(
      `${privateBase}/tasks/${taskUuid}/sync-retry`,
      'POST',
      {}
    );
    return this.syncTask(taskUuid, operator);
  }

  async reconcile(operator: AuthenticatedUser, revalidate: () => Promise<boolean>) {
    const pending = await this.worker.appleMailboxRequest<{
      tasks: { taskUuid: string; operatorId?: string }[];
    }>(`${privateBase}/sync-pending`);
    let synchronized = 0;
    for (const task of pending.tasks.slice(0, 100)) {
      if (task.operatorId && task.operatorId !== operator.id) continue;
      if (!(await revalidate())) break;
      try {
        if ((await this.syncTask(this.uuid(task.taskUuid), operator)).syncStatus === 'saved')
          synchronized += 1;
      } catch {
        /* Persisted facts remain available; this never starts registration or external uploads. */
      }
    }
    return synchronized;
  }

  syncTask(taskUuid: string, operator: AuthenticatedUser) {
    const existing = this.syncing.get(taskUuid);
    if (existing) return existing;
    const work = this.saveMirror(taskUuid, operator).finally(() => this.syncing.delete(taskUuid));
    this.syncing.set(taskUuid, work);
    return work;
  }

  private async saveMirror(taskUuid: string, operator: AuthenticatedUser) {
    const payload = await this.worker.appleMailboxRequest<AppleMailboxSyncPayload>(
      `${privateBase}/tasks/${taskUuid}/sync-payload`
    );
    if (payload.sourceTaskUuid !== taskUuid)
      throw new ConflictException('账号来源与任务不匹配，请核对原结果');
    let result: { accountId: string | null; syncStatus: 'saved' | 'failed' | 'conflict' };
    try {
      const saved = await this.accounts.mirrorRegistration(
        {
          accountId: payload.accountId,
          sourceTaskUuid: taskUuid,
          upstreamAccountId: payload.upstreamAccountId,
          email: payload.email,
          ...(payload.password ? { password: payload.password } : {}),
          registrationCountryCode: payload.registrationCountry,
          ...(payload.schemaVersion === 2
            ? {
                schemaVersion: payload.schemaVersion,
                registrationIp: payload.registrationIp,
                registeredAt: payload.registeredAt,
                creationConfirmed: payload.creationConfirmed,
                provider: payload.provider,
                identityStatus: payload.identityStatus
              }
            : {}),
          source: payload.source,
          fingerprint: payload.fingerprint
        },
        operator
      );
      result = { accountId: saved.accountId, syncStatus: 'saved' };
    } catch (error) {
      result = {
        accountId: null,
        syncStatus: error instanceof ConflictException ? 'conflict' : 'failed'
      };
    }
    // On lost MySQL/SQLite receipts the stable account UUID and same-transaction source audit
    // permit a later exact replay; raw exception messages must never cross the private bridge.
    await this.worker.appleMailboxRequest(`${privateBase}/tasks/${taskUuid}/sync-ack`, 'POST', {
      accountId: payload.accountId,
      fingerprint: payload.fingerprint,
      status: result.syncStatus,
      ...(result.syncStatus === 'saved'
        ? {}
        : {
            errorKind: result.syncStatus === 'conflict' ? 'email_conflict' : 'storage_unavailable'
          })
    });
    await this.log(operator, '隐藏邮箱主账号同步结果', `${taskUuid} · ${result.syncStatus}`);
    return result;
  }

  private uuid(value: unknown) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
      throw new BadRequestException('任务标识无效');
    return value;
  }
  private log(operator: AuthenticatedUser, action: string, remark: string) {
    return this.audit.create({
      userId: operator.id,
      module: '自动注册',
      action,
      objectType: '隐藏邮箱注册记录',
      remark
    });
  }
}
