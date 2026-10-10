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
import { AutoRegistrationService } from './auto-registration.service';
import type {
  AppleMailboxCodeRequest,
  AppleMailboxRecord,
  AppleMailboxRegistrationStatus,
  AppleMailboxRow,
  AppleMailboxSummary,
  AppleMailboxTask
} from './apple-mailboxes.types';

const privateBase = '/internal/apple-mailboxes';
const statuses = new Set(['unknown', 'unregistered', 'registered']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const normalizeEmail = (email: string) => email.trim().toLowerCase();
type Input = Record<string, unknown>;
type TaskContext = {
  aliasId: string;
  email: string;
  operator: AuthenticatedUser;
  revalidate: () => Promise<boolean>;
  startedAt: number;
  expiresAt: number;
  previousId: string | null;
  lastCheckedAt: number;
};

@Injectable()
export class AppleMailboxesService implements OnModuleDestroy {
  private readonly tasks = new Map<string, TaskContext>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private destroyed = false;

  constructor(
    private readonly worker: AutoRegistrationService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly audit: AuditLogsService
  ) {}

  onModuleDestroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.tasks.clear();
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
    const aliases = await this.mailboxes.registrationMailboxSummaries(operator);
    // IP records remain admin-only, with a read audit that contains no mailbox or IP.
    await this.log(operator, '查看邮箱注册状态');
    const records: AppleMailboxRecord[] = [];
    for (let offset = 0; offset < aliases.length; offset += 500) {
      const batch = await this.worker.appleMailboxRequest<{ records: AppleMailboxRecord[] }>(
        `${privateBase}/records`,
        'POST',
        { emails: aliases.slice(offset, offset + 500).map((item) => item.email) }
      );
      records.push(...batch.records);
    }
    const byEmail = new Map(records.map((item) => [normalizeEmail(item.email), item]));
    const items = aliases
      .map((alias) => this.row(alias, byEmail.get(normalizeEmail(alias.email))))
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
      const alias = this.alias(aliases, this.id(item.aliasId));
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
    this.only(input, ['aliasId', 'revision']);
    if (this.tasks.size >= 64) throw new ConflictException('当前注册任务较多，请稍后重试');
    const aliasId = this.id(input.aliasId);
    const revision = this.revision(input.revision);
    const mailbox = await this.mailboxes.registrationMailbox(aliasId, operator);
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    await this.log(operator, '发起隐藏邮箱注册', aliasId);
    const startedAt = Date.now();
    const result = await this.worker.appleMailboxRequest<{
      taskUuid: string;
      record: AppleMailboxRecord;
    }>(`${privateBase}/start`, 'POST', {
      aliasId,
      email: normalizeEmail(mailbox.email),
      revision,
      operatorId: operator.id
    });
    this.tasks.set(this.uuid(result.taskUuid), {
      aliasId,
      email: normalizeEmail(mailbox.email),
      operator,
      revalidate,
      startedAt,
      expiresAt: startedAt + 30 * 60_000,
      previousId: null,
      lastCheckedAt: 0
    });
    this.ensurePump();
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
    const alias = this.alias(
      await this.mailboxes.registrationMailboxSummaries(operator),
      this.id(input.aliasId)
    );
    await this.log(operator, '确认中断任务并解除占用', alias.id);
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

  private ensurePump() {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => void this.pump(), 1000);
    this.timer.unref();
  }

  /** Private pull bridge: neither worker nor browser ever receives the system JWT/query code. */
  async pump() {
    if (this.pumping || this.destroyed || !this.tasks.size) return;
    this.pumping = true;
    try {
      const pending = await this.worker.appleMailboxRequest<{
        requests: AppleMailboxCodeRequest[];
      }>(`${privateBase}/requests`);
      const requests = pending.requests.slice(0, 16);
      for (let offset = 0; offset < requests.length; offset += 4) {
        if (this.destroyed) break;
        await Promise.all(
          requests.slice(offset, offset + 4).map((request) => this.answer(request))
        );
      }
      for (const [id, context] of this.tasks) {
        if (Date.now() - context.lastCheckedAt < 5000) continue;
        context.lastCheckedAt = Date.now();
        const result = await this.worker.appleMailboxRequest<AppleMailboxTask>(
          `${privateBase}/tasks/${id}`
        );
        if (terminal.has(result.status)) {
          await this.log(context.operator, '隐藏邮箱任务结束', `${id} · ${result.status}`);
          this.tasks.delete(id);
        }
      }
      if (!this.tasks.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } catch {
      // Only retry private transport. Provider timeouts and leases remain bounded and persistent.
    } finally {
      this.pumping = false;
    }
  }

  private async answer(request: AppleMailboxCodeRequest) {
    const context = this.tasks.get(request.taskUuid);
    const since = Date.parse(request.since);
    let answer: { code: string | null; mailId: string | null; error?: string } = {
      code: null,
      mailId: null
    };
    try {
      if (
        !context ||
        context.expiresAt <= Date.now() ||
        request.aliasId !== context.aliasId ||
        normalizeEmail(request.email) !== context.email ||
        !Number.isFinite(since) ||
        since < context.startedAt - 1000 ||
        since > Date.now() + 60_000 ||
        request.previousId !== context.previousId ||
        !(await context.revalidate())
      ) {
        answer.error = 'session_invalid';
      } else {
        const task = await this.worker.appleMailboxRequest<AppleMailboxTask>(
          `${privateBase}/tasks/${this.uuid(request.taskUuid)}`
        );
        if (
          task.status !== 'running' ||
          task.record.activeTaskUuid !== request.taskUuid ||
          normalizeEmail(task.record.email) !== context.email ||
          task.record.aliasId !== context.aliasId
        ) {
          answer.error = 'mailbox_unavailable';
          await this.worker.appleMailboxRequest(
            `${privateBase}/requests/${this.uuid(request.id)}`,
            'POST',
            answer
          );
          return;
        }
        const mail = await this.mailboxes.registrationCode(
          context.aliasId,
          new Date(since),
          context.previousId,
          context.operator,
          context.email
        );
        if (mail && /^\d{6}$/.test(mail.code) && mail.mailId !== context.previousId) {
          answer = { mailId: mail.mailId, code: mail.code };
        }
      }
    } catch {
      answer = { code: null, mailId: null, error: 'mail_query_failed' };
    }
    // Await delivery before consuming a mail; retries never advance the previous-mail boundary.
    await this.worker.appleMailboxRequest(
      `${privateBase}/requests/${this.uuid(request.id)}`,
      'POST',
      answer
    );
    if (context && answer.mailId) context.previousId = answer.mailId;
  }

  private row(alias: AppleMailboxSummary, record?: AppleMailboxRecord): AppleMailboxRow {
    const registrationStatus = record?.registrationStatus ?? 'unknown';
    const blockedReason = record?.activeTaskUuid
      ? '邮箱已被任务占用，请查看进度或核对中断任务'
      : registrationStatus === 'unknown'
        ? '请先确认该邮箱是否已经注册'
        : registrationStatus === 'registered'
          ? '该邮箱已标记为已注册'
          : alias.status !== 'ACTIVE'
            ? '隐藏邮箱未启用'
            : !alias.primaryAvailable
              ? '所属主邮箱不可用'
              : !alias.authorizationValid
                ? '邮箱查询授权已失效'
                : null;
    return {
      aliasId: alias.id,
      email: alias.email,
      primaryEmail: alias.primaryEmail,
      mailboxStatus: alias.status,
      authorizationValid: alias.authorizationValid,
      primaryAvailable: alias.primaryAvailable,
      registrationStatus,
      registrationIp: record?.registrationIp ?? null,
      registrationIpSource: record?.registrationIpSource ?? null,
      source: record?.source ?? null,
      note: record?.note || alias.note,
      updatedAt: record?.markedAt ?? alias.updatedAt,
      revision: record?.revision ?? 0,
      taskUuid: record?.activeTaskUuid ?? record?.lastTaskUuid ?? null,
      taskStatus: record?.taskStatus ?? null,
      canRegister: blockedReason === null,
      blockedReason
    };
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

  private alias(aliases: AppleMailboxSummary[], id: string) {
    const alias = aliases.find((item) => item.id === id);
    if (!alias) throw new ConflictException('隐藏邮箱不存在或已移除，请刷新列表');
    return alias;
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
