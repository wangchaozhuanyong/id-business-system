import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { AutoRegistrationService } from './auto-registration.service';
import type { AppleMailboxCodeRequest, AppleMailboxTask } from './apple-mailboxes.types';
const privateBase = '/internal/apple-mailboxes';
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_review']);
export type TaskContext = {
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
export class AppleMailboxTaskBridgeService implements OnModuleDestroy {
  private readonly tasks = new Map<string, TaskContext>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private destroyed = false;
  onTerminal?: (id: string, result: AppleMailboxTask, context: TaskContext) => Promise<void>;
  constructor(
    private readonly worker: AutoRegistrationService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly audit: AuditLogsService
  ) {}
  get size() {
    return this.tasks.size;
  }
  remember(id: string, context: TaskContext) {
    this.tasks.set(this.uuid(id), context);
    this.ensurePump();
  }
  onModuleDestroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.tasks.clear();
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
  private uuid(value: unknown) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
      throw new BadRequestException('任务标识无效');
    return value;
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
          await this.onTerminal?.(id, result, context);
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
          const current = await this.worker.appleMailboxRequest<AppleMailboxTask>(
            `${privateBase}/tasks/${this.uuid(request.taskUuid)}`
          );
          if (
            this.tasks.get(request.taskUuid) !== context ||
            context.expiresAt <= Date.now() ||
            !(await context.revalidate())
          ) {
            answer.error = 'session_invalid';
          } else if (
            current.status !== 'running' ||
            current.record.activeTaskUuid !== request.taskUuid ||
            normalizeEmail(current.record.email) !== context.email ||
            current.record.aliasId !== context.aliasId
          ) {
            answer.error = 'mailbox_unavailable';
          } else {
            answer = { mailId: mail.mailId, code: mail.code };
          }
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
}
