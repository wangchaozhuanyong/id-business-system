import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy
} from '@nestjs/common';
import { isIP } from 'node:net';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  BankRechargeRegistrationMirrorService,
  RechargeProxyService
} from '../auto-recharge/public-api';
import { AutoRegistrationService } from './auto-registration.service';
import { AppleMailboxTaskBridgeService } from './apple-mailboxes-task-bridge.service';
import {
  appleMailboxAlias,
  appleMailboxRow,
  appleMailboxExecutionOptions,
  appleMailboxProxyOptions,
  appleMailboxUploadKeys
} from './apple-mailbox-pool';
import type {
  AppleMailboxBatch,
  AppleMailboxRecord,
  AppleMailboxRegistrationStatus,
  AppleMailboxTask,
  AppleMailboxSyncPayload
} from './apple-mailboxes.types';

const privateBase = '/internal/apple-mailboxes';
const statuses = new Set(['unknown', 'unregistered', 'registered']);
const normalizeEmail = (email: string) => email.trim().toLowerCase();
type Input = Record<string, unknown>;

@Injectable()
export class AppleMailboxesService implements OnModuleDestroy {
  private readonly syncing = new Map<
    string,
    Promise<{ accountId: string | null; syncStatus: 'saved' | 'failed' | 'conflict' }>
  >();

  constructor(
    private readonly worker: AutoRegistrationService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly audit: AuditLogsService,
    private readonly accounts: BankRechargeRegistrationMirrorService,
    private readonly proxies: RechargeProxyService,
    private readonly encryption: FieldEncryptionService,
    private readonly bridge: AppleMailboxTaskBridgeService
  ) {
    this.bridge.onTerminal = async (id, result, context) => {
      if (
        ['pending', 'failed'].includes(result.record.syncStatus ?? '') &&
        (await context.revalidate().catch(() => false))
      )
        await this.syncTask(id, context.operator);
    };
  }

  onModuleDestroy() {
    this.bridge.onModuleDestroy();
  }
  pump() {
    return this.bridge.pump();
  }

  async list(query: Input, operator: AuthenticatedUser) {
    this.admin(operator);
    const page = this.integer(query.page ?? '1', 1, 1_000_000);
    const pageSize = this.integer(query.pageSize ?? '20', 1, 100);
    const q = this.text(query.q ?? '', 200).toLowerCase();
    const status = query.registrationStatus ?? '';
    if (typeof status !== 'string' || (status !== '' && !statuses.has(status))) this.invalid();
    const sortBy = query.sortBy ?? 'updatedAt';
    const sortOrder = query.sortOrder ?? 'desc';
    if (!['email', 'updatedAt'].includes(String(sortBy))) this.invalid();
    if (!['asc', 'desc'].includes(String(sortOrder))) this.invalid();
    const items = (await this.rows(operator))
      .filter(
        (row) =>
          (!status || row.registrationStatus === status) &&
          (!q ||
            `${row.email} ${row.primaryEmail ?? ''} ${row.note ?? ''}`.toLowerCase().includes(q))
      )
      .sort((a, b) => {
        const order = String(a[sortBy as 'email' | 'updatedAt']).localeCompare(
          String(b[sortBy as 'email' | 'updatedAt'])
        );
        return (sortOrder === 'asc' ? order : -order) || a.aliasId.localeCompare(b.aliasId);
      });
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize
    };
  }

  async candidates(operator: AuthenticatedUser) {
    this.admin(operator);
    const items = await this.rows(operator);
    const proxies = await appleMailboxProxyOptions(this.proxies);
    return {
      items,
      total: items.length,
      available: items.filter((item) => item.canRegister).length,
      proxies
    };
  }

  private async rows(operator: AuthenticatedUser) {
    const aliases = await this.mailboxes.registrationMailboxSummaries(operator);
    await this.log(operator, '查看邮箱注册状态');
    const records: AppleMailboxRecord[] = [];
    const registered = new Set<string>();
    for (let offset = 0; offset < aliases.length; offset += 500) {
      const emails = aliases.slice(offset, offset + 500).map((item) => normalizeEmail(item.email));
      const [batch, hashes] = await Promise.all([
        this.worker.appleMailboxRequest<{ records: AppleMailboxRecord[] }>(
          `${privateBase}/records`,
          'POST',
          { emails }
        ),
        this.accounts.registeredEmailHashes(emails, operator)
      ]);
      records.push(...batch.records);
      for (const hash of hashes) registered.add(hash);
    }
    const byEmail = new Map(records.map((item) => [normalizeEmail(item.email), item]));
    return aliases.map((alias) =>
      appleMailboxRow(
        alias,
        byEmail.get(normalizeEmail(alias.email)),
        registered.has(this.encryption.hash(normalizeEmail(alias.email))!)
      )
    );
  }

  async mark(value: unknown, operator: AuthenticatedUser) {
    this.admin(operator);
    const input = this.object(value);
    this.only(input, ['items', 'registrationStatus', 'registrationIp', 'note']);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100)
      this.invalid();
    const status = this.status(input.registrationStatus);
    const registrationIp = input.registrationIp ?? null;
    if (registrationIp !== null && (typeof registrationIp !== 'string' || !isIP(registrationIp)))
      throw new BadRequestException('请填写有效的 IPv4 或 IPv6 地址，未知时留空');
    if (status !== 'registered' && registrationIp !== null)
      throw new BadRequestException('只有已注册邮箱可以补录历史注册 IP');
    const note = this.text(input.note ?? '', 500);
    const aliases = await this.mailboxes.registrationMailboxSummaries(operator);
    const seen = new Set<string>();
    const items = input.items.map((raw: unknown) => {
      const item = this.object(raw);
      this.only(item, ['aliasId', 'revision']);
      const alias = appleMailboxAlias(aliases, this.id(item.aliasId));
      const email = normalizeEmail(alias.email);
      if (seen.has(email)) throw new BadRequestException('同一邮箱不能重复标记');
      seen.add(email);
      return { aliasId: alias.id, email, revision: this.revision(item.revision) };
    });
    await this.log(operator, '标记邮箱注册状态', `数量 ${items.length}`);
    await this.worker.appleMailboxRequest(`${privateBase}/mark`, 'POST', {
      items,
      registrationStatus: status,
      registrationIp,
      note,
      operatorId: operator.id
    });
    await this.log(operator, '标记邮箱注册状态完成', `数量 ${items.length}`);
    return { updated: items.length };
  }

  async start(value: unknown, operator: AuthenticatedUser, revalidate: () => Promise<boolean>) {
    this.admin(operator);
    const input = this.object(value);
    this.only(input, ['aliasId', 'revision', 'proxyId', ...appleMailboxUploadKeys]);
    if (this.bridge.size >= 64) throw new ConflictException('当前注册任务较多，请稍后重试');
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    if ((input.aliasId === undefined) !== (input.revision === undefined)) this.invalid();
    const requestedId = input.aliasId === undefined ? undefined : this.id(input.aliasId);
    const requestedRevision = requestedId === undefined ? undefined : this.revision(input.revision);
    const options = await appleMailboxExecutionOptions(
      input,
      this.proxies,
      operator,
      requestedId === undefined ? 'automatic' : 'specified'
    );
    const rows = await this.rows(operator);
    const row =
      requestedId === undefined
        ? rows.find((item) => item.canRegister)
        : rows.find((item) => item.aliasId === requestedId);
    if (!row) throw new ConflictException('没有可注册的隐藏邮箱，请新增邮箱或刷新状态');
    if (!row.canRegister) throw new ConflictException(row.blockedReason ?? '所选邮箱不可用');
    if (requestedRevision !== undefined && requestedRevision !== row.revision)
      throw new ConflictException('邮箱登记已更新，请刷新后重试');
    const aliasId = row.aliasId;
    const revision = row.revision;
    const mailbox = await this.mailboxes.registrationMailbox(aliasId, operator);
    if (normalizeEmail(mailbox.email) !== normalizeEmail(row.email))
      throw new ConflictException('邮箱地址已变化，请刷新后重试');
    await this.log(operator, '发起隐藏邮箱注册', aliasId);
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    const startedAt = Date.now();
    const result = await this.worker.appleMailboxRequest<{
      taskUuid: string;
      record: AppleMailboxRecord;
    }>(`${privateBase}/start`, 'POST', {
      aliasId,
      email: normalizeEmail(mailbox.email),
      revision,
      operatorId: operator.id,
      options
    });
    this.bridge.remember(this.uuid(result.taskUuid), {
      aliasId,
      email: normalizeEmail(mailbox.email),
      operator,
      revalidate,
      startedAt,
      expiresAt: startedAt + 30 * 60_000,
      previousId: null,
      lastCheckedAt: 0
    });
    return result;
  }

  async batch(value: unknown, operator: AuthenticatedUser, revalidate: () => Promise<boolean>) {
    this.admin(operator);
    const input = this.object(value);
    this.only(input, [
      'targets',
      'count',
      'concurrency',
      'mode',
      'interval_min',
      'interval_max',
      'proxyId',
      ...appleMailboxUploadKeys
    ]);
    const count = this.integer(input.count ?? 1, 1, 100);
    const concurrency = this.integer(input.concurrency ?? 1, 1, 50);
    const intervalMin = this.integer(input.interval_min ?? 5, 0, 3600);
    const intervalMax = this.integer(input.interval_max ?? 30, intervalMin, 3600);
    const mode = input.mode ?? 'pipeline';
    if (mode !== 'pipeline' && mode !== 'parallel') this.invalid();
    let targets: { aliasId: string; revision: number }[] | undefined;
    if (input.targets !== undefined) {
      if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100)
        this.invalid();
      targets = input.targets.map((raw: unknown) => {
        const item = this.object(raw);
        this.only(item, ['aliasId', 'revision']);
        return { aliasId: this.id(item.aliasId), revision: this.revision(item.revision) };
      });
      if (new Set(targets.map((item) => item.aliasId)).size !== targets.length)
        throw new BadRequestException('同一邮箱不能重复加入批次');
    }
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    const options = await appleMailboxExecutionOptions(
      input,
      this.proxies,
      operator,
      targets === undefined ? 'automatic' : 'specified'
    );
    const rows = await this.rows(operator);
    const wanted =
      targets?.slice(0, count) ??
      rows
        .filter((item) => item.canRegister)
        .slice(0, count)
        .map((item) => ({ aliasId: item.aliasId, revision: item.revision }));
    const skipped: { aliasId: string; reason: string }[] = [];
    const items: { aliasId: string; email: string; revision: number }[] = [];
    const seenEmails = new Set<string>();
    for (const target of wanted) {
      const row = rows.find((item) => item.aliasId === target.aliasId);
      if (
        !row?.canRegister ||
        row.revision !== target.revision ||
        seenEmails.has(normalizeEmail(row.email))
      ) {
        skipped.push({
          aliasId: target.aliasId,
          reason: row?.blockedReason ?? '邮箱状态已变化或地址重复，请刷新'
        });
        continue;
      }
      try {
        const mailbox = await this.mailboxes.registrationMailbox(row.aliasId, operator);
        const email = normalizeEmail(mailbox.email);
        if (email !== normalizeEmail(row.email)) throw new ConflictException();
        seenEmails.add(email);
        items.push({ aliasId: row.aliasId, email, revision: row.revision });
      } catch {
        skipped.push({ aliasId: row.aliasId, reason: '邮箱已停用、授权失效或地址变化' });
      }
    }
    if (!items.length) throw new ConflictException('没有可注册的隐藏邮箱，批次未启动');
    if (this.bridge.size + items.length > 100)
      throw new ConflictException('当前注册任务较多，请减少本批数量');
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    await this.log(operator, '发起隐藏邮箱批量注册', `请求 ${count}，候选 ${items.length}`);
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    const startedAt = Date.now();
    const result = await this.worker.appleMailboxRequest<AppleMailboxBatch>(
      `${privateBase}/batch`,
      'POST',
      {
        items,
        operatorId: operator.id,
        concurrency,
        mode,
        interval_min: intervalMin,
        interval_max: intervalMax,
        options
      }
    );
    if (!result.taskUuids.length)
      throw new ConflictException('候选邮箱已被占用或状态变化，批次未启动');
    for (const record of result.records) {
      const id = record.activeTaskUuid;
      if (!id || !result.taskUuids.includes(id) || !record.aliasId) continue;
      this.bridge.remember(this.uuid(id), {
        aliasId: record.aliasId,
        email: normalizeEmail(record.email),
        operator,
        revalidate,
        startedAt,
        expiresAt: startedAt + 24 * 60 * 60_000,
        previousId: null,
        lastCheckedAt: 0
      });
    }
    return {
      ...result,
      accepted: result.taskUuids.length,
      skipped: [...skipped, ...result.skipped],
      requested: count
    };
  }

  async batchTask(id: string, operator: AuthenticatedUser) {
    this.admin(operator);
    await this.log(operator, '查看隐藏邮箱批次', this.uuid(id));
    return this.worker.appleMailboxRequest<AppleMailboxBatch>(
      `${privateBase}/batches/${this.uuid(id)}`
    );
  }

  async cancelBatch(id: string, operator: AuthenticatedUser) {
    this.admin(operator);
    await this.log(operator, '请求取消隐藏邮箱批次', this.uuid(id));
    return this.worker.appleMailboxRequest(
      `${privateBase}/batches/${this.uuid(id)}/cancel`,
      'POST',
      {}
    );
  }

  async sync(id: string, operator: AuthenticatedUser) {
    this.admin(operator);
    const taskUuid = this.uuid(id);
    await this.log(operator, '补存隐藏邮箱主账号', taskUuid);
    // Only the persisted result is read. No registration or upload is started here.
    await this.worker.appleMailboxRequest(
      `${privateBase}/tasks/${taskUuid}/sync-retry`,
      'POST',
      {}
    );
    return this.syncTask(taskUuid, operator);
  }

  async localSave(id: string, operator: AuthenticatedUser) {
    this.admin(operator);
    const taskUuid = this.uuid(id);
    await this.log(operator, '补存隐藏邮箱本地账号', taskUuid);
    const result = await this.worker.appleMailboxRequest<{ task: AppleMailboxTask }>(
      `${privateBase}/tasks/${taskUuid}/local-save-retry`,
      'POST',
      {}
    );
    return { localSaveStatus: result.task.record.localSaveStatus };
  }

  async resume(operator: AuthenticatedUser, revalidate: () => Promise<boolean>) {
    this.admin(operator);
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    await this.log(operator, '重新连接已登记的隐藏邮箱任务');
    const active = await this.worker.appleMailboxRequest<{
      tasks: {
        taskUuid: string;
        aliasId: string;
        email: string;
        operatorId: string;
        startedAt: string;
        previousId: string | null;
      }[];
    }>(`${privateBase}/tasks-active`);
    let resumed = 0;
    for (const task of active.tasks.slice(0, 100)) {
      const startedAt = Date.parse(task.startedAt);
      if (!Number.isFinite(startedAt) || startedAt > Date.now() + 1000) continue;
      try {
        const mailbox = await this.mailboxes.registrationMailbox(this.id(task.aliasId), operator);
        if (normalizeEmail(mailbox.email) !== normalizeEmail(task.email)) continue;
        this.bridge.remember(this.uuid(task.taskUuid), {
          aliasId: task.aliasId,
          email: normalizeEmail(task.email),
          operator,
          revalidate,
          startedAt,
          expiresAt: Date.now() + 30 * 60_000,
          previousId: task.previousId,
          lastCheckedAt: 0
        });
        resumed += 1;
      } catch {
        // An unavailable alias cannot be rebound to another mailbox.
      }
    }
    const pending = await this.worker.appleMailboxRequest<{ tasks: { taskUuid: string }[] }>(
      `${privateBase}/sync-pending`
    );
    let synchronized = 0;
    for (const task of pending.tasks.slice(0, 100)) {
      if (!(await revalidate())) break;
      try {
        if ((await this.syncTask(this.uuid(task.taskUuid), operator)).syncStatus === 'saved')
          synchronized += 1;
      } catch {
        /* Persisted pending facts remain available after a transport failure. */
      }
    }
    return { resumed, synchronized };
  }

  private syncTask(taskUuid: string, operator: AuthenticatedUser) {
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

  async task(taskUuid: string, operator: AuthenticatedUser) {
    this.admin(operator);
    await this.log(operator, '查看隐藏邮箱任务', this.uuid(taskUuid));
    return this.worker.appleMailboxRequest<AppleMailboxTask>(
      `${privateBase}/tasks/${this.uuid(taskUuid)}`
    );
  }

  async cancel(taskUuid: string, operator: AuthenticatedUser) {
    this.admin(operator);
    const id = this.uuid(taskUuid);
    await this.log(operator, '请求取消隐藏邮箱任务', id);
    return this.worker.appleMailboxRequest<{ accepted: boolean }>(
      `${privateBase}/tasks/${id}/cancel`,
      'POST',
      {}
    );
  }

  async recover(value: unknown, operator: AuthenticatedUser) {
    this.admin(operator);
    const input = this.object(value);
    this.only(input, ['aliasId', 'revision']);
    const alias = appleMailboxAlias(
      await this.mailboxes.registrationMailboxSummaries(operator),
      this.id(input.aliasId)
    );
    await this.log(operator, '确认待核对任务并请求解除占用', alias.id);
    const result = await this.worker.appleMailboxRequest<{ record: AppleMailboxRecord }>(
      `${privateBase}/recover`,
      'POST',
      {
        aliasId: alias.id,
        email: normalizeEmail(alias.email),
        revision: this.revision(input.revision),
        operatorId: operator.id
      }
    );
    return result.record;
  }

  private admin(operator: AuthenticatedUser) {
    if (!operator?.roles?.includes('admin')) throw new ForbiddenException('请使用管理员账号');
  }

  private log(operator: AuthenticatedUser, action: string, remark?: string) {
    return this.audit.create({
      userId: operator.id,
      module: '自动注册',
      action,
      objectType: '隐藏邮箱注册记录',
      remark
    });
  }

  private object(value: unknown): Input {
    if (!value || typeof value !== 'object' || Array.isArray(value)) this.invalid();
    return value as Input;
  }

  private only(value: Input, keys: string[]) {
    if (Object.keys(value).some((key) => !keys.includes(key))) this.invalid();
  }

  private integer(value: unknown, min: number, max: number) {
    const result =
      typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isSafeInteger(result) || result < min || result > max) this.invalid();
    return result;
  }

  private revision(value: unknown) {
    if (typeof value !== 'number') this.invalid();
    return this.integer(value, 0, Number.MAX_SAFE_INTEGER);
  }

  private text(value: unknown, max: number) {
    if (typeof value !== 'string' || value.length > max) this.invalid();
    return value.trim();
  }

  private id(value: unknown) {
    const id = this.text(value, 191);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) this.invalid();
    return id;
  }

  private uuid(value: unknown) {
    const id = this.text(value, 36);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) this.invalid();
    return id;
  }

  private status(value: unknown) {
    if (typeof value !== 'string' || !statuses.has(value)) this.invalid();
    return value as AppleMailboxRegistrationStatus;
  }

  private invalid(): never {
    throw new BadRequestException('邮箱列表或标记参数无效，请核对输入');
  }
}
