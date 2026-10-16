import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargePublicLimiter } from './public.controller';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { object, session, text } from './validation';
import { OnlineRechargeTaskNotAccepted } from './task-acceptance';

export const VENDURE_RECHARGE_SOURCE = 'vendure-storefront';
const PLANS = ['plus', 'pro_5x', 'pro_20x'];
const STATES = [
  'queued',
  'running',
  'awaiting_credentials',
  'awaiting_review',
  'succeeded',
  'failed'
];

/** Internal service DTO: never forward execution messages, results, URLs, or logs. */
export function vendureTaskView(input: unknown) {
  const row = object(input);
  if (!PLANS.includes(String(row.plan)) || !STATES.includes(String(row.status)))
    throw new BadRequestException('任务类型不受支持');
  return {
    id: text(row.id, '任务编号', 36),
    plan: row.plan,
    status: row.status,
    updatedAt: row.updatedAt,
    ...(typeof row.taskToken === 'string' ? { taskToken: row.taskToken } : {})
  };
}

@Injectable()
export class OnlineRechargeVendureIntegration implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  private readonly logger = new Logger(OnlineRechargeVendureIntegration.name);
  constructor(
    private readonly tasks: OnlineRechargeTasksService,
    private readonly limits: OnlineRechargePublicLimiter,
    private readonly repository: OnlineRechargeRepository
  ) {}

  authorize(key: unknown, ip: string | undefined) {
    const expected = process.env.ONLINE_RECHARGE_VENDURE_KEY ?? '';
    const allowed = (process.env.ONLINE_RECHARGE_VENDURE_SOURCE_IPS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedIp = ip?.replace(/^::ffff:/, '');
    const supplied = typeof key === 'string' ? key : '';
    if (
      expected.length < 32 ||
      !normalizedIp ||
      !isIP(normalizedIp) ||
      !allowed.includes(normalizedIp) ||
      !timingSafeEqual(
        createHash('sha256').update(expected).digest(),
        createHash('sha256').update(supplied).digest()
      )
    )
      throw new ForbiddenException('服务身份校验失败');
  }

  async execute(action: string, raw: unknown, clientIp: unknown) {
    const value = object(raw);
    const allowed =
      action === 'submit'
        ? ['code', 'session']
        : action === 'task'
          ? ['id', 'taskToken']
          : action === 'config'
            ? []
            : ['code'];
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new BadRequestException('不支持的请求字段');
    if (typeof clientIp !== 'string' || !isIP(clientIp))
      throw new BadRequestException('来源资料无效');
    this.limits.check(`vendure:${action}:${clientIp}`);
    if (action === 'config') {
      const config = await this.tasks.publicConfig();
      return { maintenance: config.maintenance === true };
    }
    if (action === 'task') return vendureTaskView(await this.tasks.publicTask(value));
    const code = text(value.code, '兑换码', 190);
    const verified = await this.tasks.verify({ code });
    if (!PLANS.includes(verified.plan)) throw new BadRequestException('兑换码套餐不受支持');
    if (action === 'verify') return { plan: verified.plan, status: verified.status };
    if (action === 'query') {
      const result = await this.tasks.query({ code });
      return {
        plan: result.plan,
        status: result.status,
        task: result.task ? vendureTaskView({ ...result.task, taskToken: result.taskToken }) : null
      };
    }
    if (action === 'submit') {
      try {
        session(value.session, true);
      } catch {
        throw new OnlineRechargeTaskNotAccepted();
      }
      const accepted = await this.tasks.start(
        { code, session: value.session },
        undefined,
        'recharge',
        true,
        VENDURE_RECHARGE_SOURCE
      );
      // A response-mapping failure after start resolved is an unknown outcome, never a rejection.
      try {
        return vendureTaskView(accepted);
      } catch {
        throw new Error('Accepted recharge response could not be read');
      }
    }
    throw new BadRequestException('操作无效');
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.purgeExpiredSessions().catch(() =>
        this.logger.error('Vendure session retention failed; retry scheduled')
      );
    }, 300000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purgeExpiredSessions(now = new Date()) {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      await this.repository.transaction('vendure-session-retention', async (tx) => {
        const result = await tx.onlineRechargeTask.updateMany({
          where: {
            sessionEncrypted: { not: null },
            payload: { path: '$.integrationSource', equals: VENDURE_RECHARGE_SOURCE },
            OR: [
              {
                status: { in: ['succeeded', 'failed'] },
                updatedAt: { lte: new Date(now.getTime() - 86400000) }
              },
              {
                status: 'awaiting_review',
                createdAt: { lte: new Date(now.getTime() - 7 * 86400000) }
              }
            ]
          },
          data: { sessionEncrypted: null }
        });
        if (result.count)
          await this.repository.log(tx, 'vendure.session_retention', undefined, undefined, {
            clearedSessions: result.count
          });
      });
    } finally {
      this.cleaning = false;
    }
  }
}
