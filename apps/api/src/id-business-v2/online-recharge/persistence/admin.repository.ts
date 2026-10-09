import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { freemem, totalmem, cpus, uptime } from 'node:os';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { maskLoginEventIp } from '../../../auth/login-events';
import {
  ONLINE_RECHARGE_PERMISSION,
  ONLINE_RECHARGE_SECTIONS,
  type OnlineRechargeSection
} from '../contracts';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeAssetsService } from '../assets.service';
import { OnlineRechargeSettingsService } from '../settings.service';
import { OnlineRechargeTasksService } from '../tasks.service';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { OnlineRechargeArtifactsService } from '../artifacts.service';
import { id, ids, object, sanitize } from '../validation';

@Injectable()
export class OnlineRechargeAdminRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly assets: OnlineRechargeAssetsService,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly tasks: OnlineRechargeTasksService,
    private readonly credentials: OnlineRechargeEphemeralCredentials,
    private readonly artifacts: OnlineRechargeArtifactsService
  ) {}
  async overview() {
    const counts = await this.repository.read(async (db) => {
      const [tasks, codes, cards, billing, active] = await Promise.all([
        db.onlineRechargeTask.groupBy({ by: ['status'], _count: true }),
        db.onlineRechargeCode.groupBy({ by: ['status'], _count: true }),
        db.onlineRechargeCard.groupBy({ by: ['status'], _count: true }),
        db.onlineRechargeBill.groupBy({
          by: ['currency'],
          where: { status: 'success' },
          _sum: { amount: true },
          _count: true
        }),
        db.onlineRechargeTask.count({ where: { status: 'running' } })
      ]);
      return {
        tasks,
        codes,
        cards,
        billing: billing.map((row) => ({
          currency: row.currency,
          amount: row._sum.amount?.toString() ?? null,
          count: row._count
        })),
        active
      };
    });
    const disk = await statfs(resolve(__dirname, '../../../../../..')).catch(() => null);
    return {
      ...counts,
      config: await this.settings.get(),
      runtime: {
        cpuCores: cpus().length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        uptime: uptime(),
        diskTotal: disk ? disk.blocks * disk.bsize : null,
        diskFree: disk ? disk.bavail * disk.bsize : null
      },
      sourceVersion: 'ba6cf96312a6953e62edb9d74299d438d12549df'
    };
  }
  async list(section: string, query: Record<string, unknown>, operator: AuthenticatedUser) {
    if (section === 'login-logs' && !operator.roles.includes('admin'))
      throw new ForbiddenException('安全日志仅管理员可查看');
    if (section === 'browser-pool') {
      const config = await this.settings.get();
      const latest = await this.repository.read((db) =>
        db.onlineRechargeTask.findFirst({
          where: { operation: 'browser_manage', status: 'succeeded' },
          orderBy: { updatedAt: 'desc' }
        })
      );
      const stats = latest?.result ? object(latest.result) : null;
      const rawSlots = stats && Array.isArray(stats.slots) ? stats.slots : [];
      const items = rawSlots.map((raw, index) => {
        const slot = object(raw);
        return {
          ...(sanitize(slot) as Record<string, unknown>),
          id: String(slot.slotId ?? index + 1),
          status: slot.inUse === true ? 'busy' : 'idle',
          activeTaskId: slot.jobKey ?? null,
          browserMode: stats?.mode ?? config.browserMode
        };
      });
      return {
        items,
        total: items.length,
        page: 1,
        pageSize: 100,
        config,
        runtime: stats,
        observedAt: latest?.updatedAt ?? null
      };
    }
    if (!ONLINE_RECHARGE_SECTIONS.includes(section as OnlineRechargeSection))
      throw new BadRequestException('页面资源无效');
    const result = await this.repository.list(section as OnlineRechargeSection, query);
    if (['jobs', 'automation', 'sessions', 'renewal'].includes(section))
      return {
        ...result,
        items: result.items.map((row) =>
          this.tasks.map(row as Parameters<OnlineRechargeTasksService['map']>[0])
        )
      };
    if (section === 'cards') {
      const available = await this.credentials.available(
        result.items.map((row) => (row as { id: string }).id)
      );
      return {
        ...result,
        items: result.items.map((row) => {
          const item = sanitize(JSON.parse(JSON.stringify(row))) as Record<string, unknown>;
          delete item.numberHash;
          delete item.leaseId;
          delete item.leaseOwner;
          return { ...item, hasCvc: available.includes(String(item.id)) };
        })
      };
    }
    if (section === 'login-logs')
      return {
        ...result,
        items: result.items.map((row) => {
          const log = row as {
            id: string;
            username: string;
            status: string;
            failureReason: string | null;
            ip: string | null;
            abnormal: boolean;
            createdAt: Date;
          };
          const reason = log.failureReason ?? '';
          const event =
            log.status === 'success'
              ? '登录成功'
              : reason.startsWith('mfa_')
                ? '多因素认证失败'
                : log.status === 'blocked'
                  ? '登录被阻止'
                  : '登录失败';
          const reasons: Record<string, string> = {
            password_invalid: '密码验证失败',
            user_not_found: '账号不存在',
            ip_not_allowed: '来源未在允许范围',
            mfa_not_bound: '未绑定多因素认证',
            mfa_required: '需要多因素认证',
            mfa_invalid: '多因素验证失败'
          };
          return {
            id: log.id,
            userName: log.username,
            status: log.status,
            event,
            ipMasked: maskLoginEventIp(log.ip) ?? '',
            failureReason:
              reasons[reason] ??
              (reason.startsWith('user_status_') ? '账号状态不可登录' : reason ? '认证未完成' : ''),
            abnormal: log.abnormal,
            createdAt: log.createdAt
          };
        })
      };
    return {
      ...result,
      items: result.items.map((row) => {
        const item = sanitize(JSON.parse(JSON.stringify(row))) as Record<string, unknown>;
        if (section === 'cdks') {
          delete item.codeHash;
          item.code = `····${item.codeLast4}`;
        }
        if (section === 'proxies') delete item.connectionHash;
        return item;
      })
    };
  }
  async action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    const readActions = [
      'detail',
      'subscribe',
      'artifacts',
      'summary',
      'export',
      'reveal',
      'checkout-link'
    ];
    if (
      !readActions.includes(action) &&
      !operator.roles.includes('admin') &&
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage)
    )
      throw new ForbiddenException('没有管理线上代充的权限');
    if (section === 'proxies' && action === 'test') {
      const selected =
        input.id || input.ids
          ? ids(input)
          : (
              await this.repository.read((db) =>
                db.onlineRechargeProxy.findMany({
                  where: { status: 'active' },
                  select: { id: true },
                  take: 500
                })
              )
            ).map((row) => row.id);
      const tasks: unknown[] = [];
      for (const proxyId of selected)
        tasks.push(await this.tasks.start({ proxyId }, operator, 'proxy_test'));
      return { tasks };
    }
    if (section === 'config' && action === 'test') {
      const aliases: Record<string, string> = {
        hcaptcha: 'solver',
        'captcha-platform': 'captcha_platform',
        'gpt-api': 'gpt_api',
        'gpt-api-status': 'gpt_status'
      };
      const target = aliases[String(input.target)] ?? String(input.target);
      if (
        ![
          'telegram',
          'solver',
          'vlm',
          'captcha_platform',
          'gpt_api',
          'gpt_status',
          'solver_logs'
        ].includes(target)
      )
        throw new BadRequestException('测试目标无效');
      return this.tasks.start({ ...input, target }, operator, 'config_test');
    }
    if (section === 'browser-pool') {
      if (action === 'mode')
        await this.settings.update(
          {
            browserMode: input.mode,
            ...(input.version !== undefined ? { version: input.version } : {})
          },
          operator
        );
      else if (action === 'reload' && input.size !== undefined)
        await this.settings.update({ browserPoolSize: input.size }, operator);
      if (!['mode', 'reload', 'test'].includes(action))
        throw new BadRequestException('浏览器操作无效');
      return this.tasks.start({ ...input, action }, operator, 'browser_manage');
    }
    if (section === 'cdks' && action === 'detail')
      return this.repository.read(async (db) => {
        const row = await db.onlineRechargeCode.findUnique({ where: { id: id(input.id) } });
        if (!row) throw new BadRequestException('兑换码不存在');
        return {
          id: row.id,
          plan: row.plan,
          status: row.status,
          dispatched: row.dispatched,
          task: row.taskId ? await this.tasks.get(row.taskId) : null
        };
      });
    if (['cards', 'proxies', 'addresses', 'cdks'].includes(section))
      return this.assets.action(section, action, input, operator);
    if (action === 'artifacts') return this.artifacts.list(id(input.id));
    if (['jobs', 'automation', 'sessions', 'renewal', 'checkout-debug'].includes(section))
      return this.tasks.action(section, action, input, operator);
    if (section === 'billing') return this.billing(action, input, operator);
    if (section === 'runtime-logs') return this.logs(action, input, operator);
    throw new BadRequestException('不支持该页面操作');
  }
  private async billing(
    action: string,
    input: Record<string, unknown>,
    operator: AuthenticatedUser
  ) {
    if (action === 'detail')
      return this.repository.read(async (db) => {
        const row = await db.onlineRechargeBill.findUnique({ where: { id: id(input.id) } });
        if (!row) throw new BadRequestException('账单不存在');
        return sanitize(JSON.parse(JSON.stringify(row)));
      });
    if (action === 'summary')
      return this.repository.read(async (db) =>
        (
          await db.onlineRechargeBill.groupBy({
            by: ['cardLast4', 'currency'],
            where: {
              status: 'success',
              ...(input.cardLast4 ? { cardLast4: String(input.cardLast4) } : {})
            },
            _sum: { amount: true },
            _count: true
          })
        ).map((row) => ({
          cardLast4: row.cardLast4,
          currency: row.currency,
          amount: row._sum.amount?.toString() ?? null,
          count: row._count
        }))
      );
    if (action === 'export') {
      const rows = await this.exportRows('billing', input);
      const csv = [
        '支付时间,卡尾号,实际金额,币种,套餐,结果',
        ...rows.map((row) => {
          const bill = row as {
            createdAt: Date;
            cardLast4: string | null;
            amount: Prisma.Decimal | null;
            currency: string;
            plan: string;
            status: string;
          };
          return [
            bill.createdAt.toISOString(),
            bill.cardLast4,
            bill.amount?.toString() ?? '',
            bill.currency,
            ({ plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' } as Record<string, string>)[
              bill.plan
            ],
            (
              { success: '成功', failed: '失败', result_unknown: '待核对' } as Record<
                string,
                string
              >
            )[bill.status]
          ]
            .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
            .join(',');
        })
      ].join('\r\n');
      await this.repository.transaction('billing-export', (tx) =>
        this.repository.log(tx, 'billing.export', operator, undefined, { count: rows.length })
      );
      return { content: '\uFEFF' + csv, filename: '线上代充账单.csv' };
    }
    return this.repository.transaction('billing-delete', async (tx) => {
      const where: Prisma.OnlineRechargeBillWhereInput =
        action === 'clear-failed' ? { status: 'failed' } : { id: { in: ids(input) } };
      const rows = await tx.onlineRechargeBill.findMany({ where });
      if (
        rows.some((row) => row.status === 'result_unknown') ||
        (await tx.onlineRechargeTask.count({
          where: {
            id: { in: rows.map((row) => row.taskId) },
            status: { in: ['queued', 'running', 'awaiting_credentials', 'awaiting_review'] }
          }
        }))
      )
        throw new ConflictException('账单关联执行中或待核对任务，不能删除');
      if (!['delete', 'clear-failed'].includes(action))
        throw new BadRequestException('账单操作无效');
      const result = await tx.onlineRechargeBill.deleteMany({ where });
      await this.repository.log(tx, `billing.${action}`, operator, undefined, {
        count: result.count
      });
      return { success: true, count: result.count };
    });
  }
  private async logs(action: string, input: Record<string, unknown>, operator: AuthenticatedUser) {
    if (action === 'export') {
      const result = await this.exportRows('runtime-logs', input);
      return {
        content: result
          .map((row) => {
            const event = row as { createdAt: Date; message: string };
            return `${event.createdAt.toISOString()} ${event.message}`;
          })
          .join('\n'),
        filename: '线上代充运行日志.txt'
      };
    }
    if (action !== 'clear') throw new BadRequestException('日志操作无效');
    return this.repository.transaction('logs-clear', async (tx) => {
      // 清空可见运行日志，保留付款、幂等及运行资料证据。
      const count = await tx.onlineRechargeEvent.count();
      await tx.onlineRechargeEvent.create({
        data: { stage: 'runtime_clear', message: '管理员清空运行日志视图' }
      });
      await this.repository.log(tx, 'runtime_logs.clear', operator, undefined, { count });
      return { success: true, count };
    });
  }
  private async exportRows(section: OnlineRechargeSection, query: Record<string, unknown>) {
    const rows: unknown[] = [];
    for (let page = 1; ; page++) {
      const result = await this.repository.list(section, { ...query, page, pageSize: 100 });
      if (result.total > 100000) throw new BadRequestException('导出超过10万条，请缩小查询范围');
      rows.push(...result.items);
      if (rows.length >= result.total || !result.items.length) return rows;
    }
  }
}
