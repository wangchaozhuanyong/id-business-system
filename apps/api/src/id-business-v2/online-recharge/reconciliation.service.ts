import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';

@Injectable()
export class OnlineRechargeReconciliationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;
  constructor(private readonly tasks: OnlineRechargeTasksRepository) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.process(), 10000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.tasks.processDueRechecks();
    } catch {
      // An unsuccessful scheduling transaction is retried by the next bounded scan.
    } finally {
      this.processing = false;
    }
  }
}
