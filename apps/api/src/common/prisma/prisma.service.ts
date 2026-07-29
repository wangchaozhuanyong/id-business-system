import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const DATABASE_CONNECT_MAX_ATTEMPTS = 6;
const DATABASE_CONNECT_BASE_DELAY_MS = 500;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      return;
    }

    await this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private async connectWithRetry() {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DATABASE_CONNECT_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.$connect();
        if (attempt > 1) {
          this.logger.log(`Database connection recovered on attempt ${attempt}`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= DATABASE_CONNECT_MAX_ATTEMPTS) break;

        const delayMs = DATABASE_CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(`Database connection attempt ${attempt} failed, retrying in ${delayMs}ms`);
        await this.sleep(delayMs);
      }
    }

    throw lastError;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
