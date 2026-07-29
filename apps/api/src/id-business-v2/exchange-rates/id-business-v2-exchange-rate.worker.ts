import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IdBusinessV2ExchangeRatePersistenceService,
  IdBusinessV2ExchangeRateRunError
} from './id-business-v2-exchange-rate-persistence.service';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';

const TICK_MS = 30_000;
const STALE_RUN_MS = 5 * 60_000;

@Injectable()
export class IdBusinessV2ExchangeRateWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2ExchangeRateWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: IdBusinessV2ExchangeRateSettingsService,
    private readonly persistenceService: IdBusinessV2ExchangeRatePersistenceService
  ) {}

  onModuleInit() {
    if (process.env.CLOUDFLARE_WORKER === 'true' || process.env.SUPABASE_EDGE_FUNCTION === 'true') {
      this.logger.warn('V2 汇率进程内定时器在 Edge Runtime 中禁用，请使用数据库 Cron');
      return;
    }
    if (!this.settingsService.isNetworkEnabled()) {
      this.logger.warn('V2 汇率网络采集已被环境紧急开关关闭');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    if (process.env.ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP !== 'false') {
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collectManual(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    this.assertNetworkEnabled();
    await this.recoverStaleRuns();
    const settings = await this.settingsService.getRecord();
    try {
      return await this.persistenceService.collectAndPersist({
        triggerType: 'manual',
        targetAmountRmb: settings.targetAmountRmb,
        triggeredByUserId: operator.id
      });
    } catch (error) {
      if (error instanceof IdBusinessV2ExchangeRateRunError) {
        throw new BadGatewayException({
          message: error.message,
          code: error.code,
          runId: error.runId,
          provider: error.provider,
          side: error.side,
          retryable: error.retryable
        });
      }
      throw error;
    }
  }

  async getRuntime() {
    const [settings, databaseRunning] = await Promise.all([
      this.settingsService.get(),
      this.prisma.idBusinessV2ExchangeRateRun.findFirst({
        where: { status: 'running' },
        select: { id: true, triggerType: true, targetAmountRmb: true, startedAt: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }]
      })
    ]);
    return {
      settings,
      scheduler: {
        tickIntervalMs: TICK_MS,
        localRunning: this.running,
        lastTickAt: this.lastTickAt,
        databaseRunning: databaseRunning
          ? {
              ...databaseRunning,
              targetAmountRmb: databaseRunning.targetAmountRmb?.toString() ?? null
            }
          : null
      },
      providers: [
        {
          code: 'binance',
          source: 'https://p2p.binance.com/',
          contract: 'binance-p2p-friendly-adv-search-v2'
        },
        {
          code: 'okx',
          source: 'https://www.okx.com/',
          contract: 'okx-public-trading-orders-books-v3'
        }
      ],
      successBoundary: '只有 Binance 与 OKX 四个方向都达到有效样本要求并原子保存，才会生成成功快照',
      retention: {
        days: 30,
        preservesReferencedSnapshots: true
      }
    };
  }

  async tick() {
    try {
      await this.runScheduled();
    } catch (error) {
      if (error instanceof IdBusinessV2ExchangeRateRunError) {
        this.logger.warn(`定时汇率采集失败：${error.code}`);
      } else {
        this.logger.warn('定时汇率采集未执行或发生未分类错误');
      }
    }
  }

  async runScheduled() {
    this.lastTickAt = new Date();
    if (this.running) {
      return {
        status: 'skipped' as const,
        reason: 'local_run_active' as const
      };
    }
    this.assertNetworkEnabled();
    if (!process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('汇率采集缺少数据库连接');
    }

    this.running = true;
    try {
      await this.recoverStaleRuns();
      const claimed = await this.settingsService.claimDueSchedule();
      if (!claimed) {
        return {
          status: 'skipped' as const,
          reason: 'not_due' as const
        };
      }
      const result = await this.persistenceService.collectAndPersist({
        triggerType: 'scheduled',
        targetAmountRmb: claimed.targetAmountRmb
      });
      return {
        status: 'collected' as const,
        runId: result.runId,
        midRateToRmb: result.midRateToRmb,
        validSampleCount: result.validSampleCount
      };
    } finally {
      this.running = false;
    }
  }

  private async recoverStaleRuns() {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const staleRuns = await this.prisma.idBusinessV2ExchangeRateRun.findMany({
      where: { status: 'running', startedAt: { lt: staleBefore } },
      select: { id: true, startedAt: true },
      take: 10
    });
    for (const run of staleRuns) {
      await this.prisma.idBusinessV2ExchangeRateRun.updateMany({
        where: { id: run.id, status: 'running', startedAt: run.startedAt },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorCode: 'exchange_rate_stale_run_recovered',
          errorMessage: '汇率采集超过运行时限，系统已结束该批次',
          errorProvider: 'system',
          errorRetryable: true,
          errorDetails: {
            source: 'exchange_rate_scheduler',
            staleAfterMs: STALE_RUN_MS
          }
        }
      });
    }
  }

  private assertNetworkEnabled() {
    if (process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE === 'true') {
      throw new ServiceUnavailableException('当前运行模式未启用自动汇率采集');
    }
    if (!this.settingsService.isNetworkEnabled()) {
      throw new ServiceUnavailableException('汇率网络采集已被环境紧急开关关闭');
    }
  }
}
