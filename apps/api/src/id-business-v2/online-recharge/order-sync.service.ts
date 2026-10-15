import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2CommandTransaction } from '../runtime/public-api';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';

@Injectable()
export class OnlineRechargeOrderSyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly sync: OnlineRechargeOrderSyncRepository) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.sync.processPending().catch(() => undefined), 10000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  enqueueInTransaction(tx: V2CommandTransaction, taskId: string) {
    return this.sync.enqueueInTransaction(tx, taskId);
  }
  summary(taskId: string, tx?: V2CommandTransaction) {
    return this.sync.summary(taskId, tx);
  }
  enqueue(taskId: string, operator: AuthenticatedUser) {
    return this.sync.enqueue(taskId, operator);
  }
  processPending() {
    return this.sync.processPending();
  }
  preview(raw: unknown, operator: AuthenticatedUser) {
    return this.sync.preview(raw, operator);
  }
  backfill(raw: unknown, operator: AuthenticatedUser) {
    return this.sync.backfill(raw, operator);
  }
}
