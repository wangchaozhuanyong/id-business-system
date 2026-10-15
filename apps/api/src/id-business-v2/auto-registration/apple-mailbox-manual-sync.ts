import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { BankRechargeRegistrationMirrorService } from '../auto-recharge/public-api';
import type { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import type { AutoRegistrationService } from './auto-registration.service';
import type { AppleMailboxRecord } from './apple-mailboxes.types';

const base = '/internal/apple-mailboxes';
type Target = { aliasId: string; email: string; revision: number };
type PreviewStatus = 'create' | 'exists' | 'conflict' | 'deleted' | 'busy' | 'stale' | 'ineligible';
type PreviewItem = Target & { status: PreviewStatus; accountId: string | null };
export type ManualSyncResult = {
  items: {
    aliasId: string;
    status: 'saved' | 'failed' | 'conflict' | 'skipped';
    accountId: string | null;
  }[];
  synchronized: number;
  failed: number;
  skipped: number;
};

/** Mirrors only confirmed manual facts. It never registers, restores or edits an existing account. */
export class AppleMailboxManualSync {
  constructor(
    private readonly worker: AutoRegistrationService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly accounts: BankRechargeRegistrationMirrorService,
    private readonly audit: AuditLogsService
  ) {}

  async syncMarked(items: Target[], operator: AuthenticatedUser) {
    try {
      const current = await this.worker.appleMailboxRequest<{ records: AppleMailboxRecord[] }>(
        `${base}/records`,
        'POST',
        { emails: items.map((item) => item.email) }
      );
      const byEmail = new Map(
        current.records.map((record) => [record.email.trim().toLowerCase(), record])
      );
      const targets = items.flatMap((item) => {
        const record = byEmail.get(item.email);
        return record && record.source === 'manual' && record.registrationStatus === 'registered'
          ? [{ ...item, revision: record.revision }]
          : [];
      });
      return {
        updated: items.length,
        synchronization: await this.syncTargets(targets, operator)
      };
    } catch {
      // The mark was committed already; report the independent mirror failure honestly.
      return {
        updated: items.length,
        synchronization: {
          items: items.map((item) => ({
            aliasId: item.aliasId,
            status: 'failed' as const,
            accountId: null
          })),
          synchronized: 0,
          failed: items.length,
          skipped: 0
        }
      };
    }
  }

  async preview(value: unknown, operator: AuthenticatedUser) {
    const targets = await this.targets(value, operator);
    const records = await this.records(targets);
    const items: PreviewItem[] = [];
    for (const target of targets) {
      const record = records.get(target.email);
      const status = this.ineligible(target, record);
      const result = status
        ? { status, accountId: null }
        : await this.accounts.previewManualRegistered(
            { ...target, registrationIp: record?.registrationIp },
            operator
          );
      items.push({ ...target, ...result, accountId: result.accountId ?? null });
    }
    await this.log(operator, '预览人工已注册账号补齐', `数量 ${items.length}`);
    return {
      items,
      total: items.length,
      creatable: items.filter((item) => item.status === 'create').length
    };
  }

  async sync(value: unknown, operator: AuthenticatedUser): Promise<ManualSyncResult> {
    const targets = await this.targets(value, operator);
    return this.syncTargets(targets, operator);
  }

  async syncTargets(targets: Target[], operator: AuthenticatedUser): Promise<ManualSyncResult> {
    const records = await this.records(targets);
    const items: ManualSyncResult['items'] = [];
    await this.log(operator, '补齐人工已注册账号', `数量 ${targets.length}`);
    for (const target of targets) {
      if (this.ineligible(target, records.get(target.email))) {
        items.push({ aliasId: target.aliasId, status: 'skipped', accountId: null });
        continue;
      }
      let prepared: AppleMailboxRecord | undefined;
      let accountId: string | null = null;
      let status: 'saved' | 'failed' | 'conflict';
      try {
        const result = await this.worker.appleMailboxRequest<{ record: AppleMailboxRecord }>(
          `${base}/manual-sync-prepare`,
          'POST',
          { ...target, operatorId: operator.id }
        );
        prepared = result.record;
        if (
          !prepared?.manualSyncId ||
          prepared.email.trim().toLowerCase() !== target.email ||
          prepared.aliasId !== target.aliasId ||
          prepared.source !== 'manual' ||
          prepared.registrationStatus !== 'registered' ||
          prepared.creationConfirmed ||
          prepared.activeTaskUuid
        )
          throw new ConflictException('邮箱标记已变化，请刷新后重试');
        const saved = await this.accounts.mirrorManualRegistered(
          { ...target, revision: prepared.revision, registrationIp: prepared.registrationIp },
          operator
        );
        accountId = saved.accountId;
        status = 'saved';
      } catch (error) {
        status = error instanceof ConflictException ? 'conflict' : 'failed';
      }
      if (prepared?.manualSyncId) {
        try {
          await this.worker.appleMailboxRequest(`${base}/manual-sync-ack`, 'POST', {
            email: target.email,
            aliasId: target.aliasId,
            revision: prepared.revision,
            manualSyncId: prepared.manualSyncId,
            accountId,
            status,
            ...(status === 'saved'
              ? {}
              : { errorKind: status === 'conflict' ? 'email_conflict' : 'storage_unavailable' })
          });
        } catch {
          // The main row may already exist; replay is safe after a lost acknowledgement.
          status = 'failed';
        }
      }
      items.push({ aliasId: target.aliasId, accountId, status });
    }
    const synchronized = items.filter((item) => item.status === 'saved').length;
    const skipped = items.filter((item) => item.status === 'skipped').length;
    const failed = items.length - synchronized - skipped;
    await this.log(
      operator,
      '人工已注册账号补齐结果',
      `成功 ${synchronized}，失败 ${failed}，跳过 ${skipped}`
    );
    return { items, synchronized, failed, skipped };
  }

  private ineligible(target: Target, record?: AppleMailboxRecord): PreviewStatus | null {
    if (!record || record.revision !== target.revision || record.aliasId !== target.aliasId)
      return 'stale';
    if (record.activeTaskUuid) return 'busy';
    if (
      record.registrationStatus !== 'registered' ||
      record.source !== 'manual' ||
      record.creationConfirmed
    )
      return 'ineligible';
    return null;
  }

  private async records(targets: Target[]) {
    if (!targets.length) return new Map<string, AppleMailboxRecord>();
    const result = await this.worker.appleMailboxRequest<{ records: AppleMailboxRecord[] }>(
      `${base}/records`,
      'POST',
      { emails: targets.map((target) => target.email) }
    );
    return new Map(result.records.map((record) => [record.email.trim().toLowerCase(), record]));
  }

  private async targets(value: unknown, operator: AuthenticatedUser): Promise<Target[]> {
    if (!operator.roles.includes('admin')) throw new ForbiddenException('仅管理员可以补齐账号');
    const input = this.object(value);
    if (
      Object.keys(input).some((key) => key !== 'items') ||
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 100
    )
      this.invalid();
    const aliases = await this.mailboxes.registrationMailboxSummaries(operator);
    const seen = new Set<string>();
    return input.items.map((raw: unknown) => {
      const item = this.object(raw);
      if (
        Object.keys(item).some((key) => !['aliasId', 'revision'].includes(key)) ||
        typeof item.aliasId !== 'string' ||
        item.aliasId.length > 191 ||
        !Number.isSafeInteger(item.revision) ||
        Number(item.revision) < 0
      )
        this.invalid();
      const alias = aliases.find((row) => row.id === item.aliasId);
      if (!alias) throw new ConflictException('隐藏邮箱不存在或已移除，请刷新列表');
      const email = alias.email.trim().toLowerCase();
      if (seen.has(email)) this.invalid();
      seen.add(email);
      return { aliasId: alias.id, email, revision: item.revision as number };
    });
  }

  private object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) this.invalid();
    return value as Record<string, unknown>;
  }
  private invalid(): never {
    throw new BadRequestException('人工账号补齐参数无效，请刷新列表后重试');
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
