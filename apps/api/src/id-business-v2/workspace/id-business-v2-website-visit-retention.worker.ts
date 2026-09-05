import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IdBusinessV2WebsiteVisitService } from './id-business-v2-website-visit.service';

@Injectable()
export class IdBusinessV2WebsiteVisitRetentionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2WebsiteVisitRetentionWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly service: IdBusinessV2WebsiteVisitService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runNow(), 60_000);
    this.timer.unref?.();
    void this.runNow();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runNow() {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.removeExpired();
    } catch {
      this.logger.warn('访问记录保留期限清理失败，将自动重试');
    } finally {
      this.running = false;
    }
  }
}
