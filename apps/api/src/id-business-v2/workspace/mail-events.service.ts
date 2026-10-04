import {
  ConflictException,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import type { MailEvent } from './mail-event';
import { MailEventRepository } from './persistence/mail-event.repository';

type MailHandler = (aliasId: string | null) => Promise<void>;

@Injectable()
export class MailEventsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly handlers = new Set<MailHandler>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  constructor(
    private readonly repository: MailEventRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly config: ConfigService
  ) {}
  subscribe(handler: MailHandler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  onApplicationBootstrap() {
    if ((this.config.get<string>('VENDURE_MAILBOX_WEBHOOK_SECRET')?.length ?? 0) >= 32)
      this.recover();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.handlers.clear();
  }

  async accept(event: MailEvent) {
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    let receipt = await this.repository.find(event.eventId);
    if (!receipt) {
      try {
        receipt = await this.transactions.execute(
          async (tx) => {
            const saved = await this.repository.create(tx, event, hash);
            await this.audit.append(tx, {
              module: 'id_business_v2',
              action: 'id_business_v2.vendure_mailbox.receive_event',
              objectType: 'vendure_mailbox',
              objectId: event.eventId
            });
            return saved;
          },
          { changedScopes: ['vendure-mailbox'], requestId: event.eventId, retryMode: 'none' }
        );
      } catch (error) {
        receipt = await this.repository.find(event.eventId);
        if (!receipt) throw error;
      }
    }
    if (receipt.payloadHash !== hash) throw new ConflictException('邮件事件编号已被使用');
    if (!receipt.processedAt) await this.process(receipt.id, receipt.virtualEmailId);
    return { accepted: true };
  }
  private process(id: string, aliasId: string | null) {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const promise = (async () => {
      for (const handler of this.handlers) await handler(aliasId);
      await this.repository.processed(id);
    })().finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, promise);
    return promise;
  }
  private recover() {
    if (this.stopped) return;
    void (async () => {
      while (!this.stopped) {
        const receipts = await this.repository.pending();
        if (!receipts.length) {
          this.failures = 0;
          return;
        }
        for (const receipt of receipts) await this.process(receipt.id, receipt.virtualEmailId);
      }
    })().catch(() => {
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.recover(),
          Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6))
        );
    });
  }
}
