import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import { OnlineRechargeSettingsService } from '../settings.service';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeArtifactsService } from '../artifacts.service';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { id, object, text } from '../validation';

export function secureEqual(left: unknown, right: string | undefined) {
  if (typeof left !== 'string' || !right || right.length < 32) return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class OnlineRechargeWorkerRpcRepository {
  constructor(
    private readonly config: ConfigService,
    private readonly repository: OnlineRechargeRepository,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly encryption: FieldEncryptionService,
    private readonly artifacts: OnlineRechargeArtifactsService
  ) {}
  authorize(token: unknown) {
    if (!secureEqual(token, this.config.get<string>('ONLINE_RECHARGE_WORKER_KEY')))
      throw new UnauthorizedException('执行器凭证无效');
  }
  async rpc(token: unknown, raw: unknown) {
    this.authorize(token);
    const input = object(raw),
      args = input.args ? object(input.args) : {};
    const rpc: OnlineRechargeWorkerRpc = {
      method: text(input.method, '方法', 100),
      args,
      taskId:
        typeof input.taskId === 'string'
          ? input.taskId
          : typeof args.taskId === 'string'
            ? args.taskId
            : typeof args.ownerKey === 'string'
              ? args.ownerKey
              : undefined,
      workerId: String(input.workerId ?? args.workerId ?? ''),
      leaseId: String(input.leaseId ?? args.leaseId ?? ''),
      leaseVersion: Number(input.leaseVersion ?? args.leaseVersion)
    };
    switch (rpc.method) {
      case 'claimJob':
        return this.workers.claim(text(args.workerId ?? input.workerId, '执行器编号', 100));
      case 'heartbeat':
        return this.workers.heartbeat(rpc);
      case 'progress':
        return this.workers.progress(rpc);
      case 'beforeExternalSubmit':
        return this.workers.beforeSubmit(rpc);
      case 'completeJob':
        return this.workers.finish(rpc, false);
      case 'failJob':
        return this.workers.finish(rpc, true);
      case 'reserveCard':
        return this.workers.reserveCard(rpc);
      case 'releaseCard':
      case 'recordCardUsage':
      case 'recordCardDecline':
      case 'bindCardPaymentProfile':
        return this.workers.cardAction(rpc, rpc.method);
      case 'createBillingRecord':
        return this.workers.billing(rpc);
      case 'markAddressBound':
        return this.workers.markAddress(rpc);
      case 'evidenceUpload':
        return this.artifacts.upload(rpc);
      case 'getRuntimeConfig': {
        // 池的父进程只读公共运行参数；任务上下文才能取得执行所需密钥。
        if (!rpc.taskId) {
          const config = await this.settings.get();
          return {
            ...config,
            browserPool: { enabled: config.browserMode === 'pool', size: config.browserPoolSize }
          };
        }
        await this.workers.withLease(rpc, async (tx, row) => {
          await this.repository.log(tx, 'worker.config.credentials', undefined, row.id);
        });
        return this.settings.runtime();
      }
      case 'getCardPolicy':
        await this.assertLease(rpc);
        return this.settings.cardPolicy();
      case 'getPaymentRegion':
        await this.assertLease(rpc);
        return (await this.settings.internal()).settings.paymentRegion;
      case 'verifyCdkDetails':
        return this.workers.withLease(rpc, async (tx, row) => {
          const code = row.codeId
            ? await tx.onlineRechargeCode.findUnique({ where: { id: row.codeId } })
            : null;
          return {
            valid: Boolean(code),
            type: 'activation',
            plan_type: row.plan,
            plan_name: (await this.settings.runtime()).planNames[row.plan],
            code: this.encryption.decrypt(code?.codeEncrypted)
          };
        });
      case 'getActiveProxy':
        return this.workers.withLease(rpc, async (tx, row) => {
          const proxyId =
            typeof args.proxyId === 'string'
              ? id(args.proxyId)
              : row.payload &&
                  typeof row.payload === 'object' &&
                  !Array.isArray(row.payload) &&
                  typeof row.payload.proxyId === 'string'
                ? id(row.payload.proxyId)
                : null;
          const rows = await tx.onlineRechargeProxy.findMany({
            where: { status: 'active', ...(proxyId ? { id: proxyId } : {}) },
            take: 500
          });
          if (!rows.length) return null;
          const proxy = rows[Math.floor(Math.random() * rows.length)];
          await this.repository.log(tx, 'worker.proxy.credentials', undefined, row.id, {
            proxyId: proxy.id
          });
          return {
            id: proxy.id,
            proxy_url: this.encryption.decrypt(proxy.connectionEncrypted),
            protocol: proxy.protocol,
            host: proxy.displayHost
          };
        });
      case 'listAddresses':
        return this.workers.withLease(rpc, async (tx) =>
          (
            await tx.onlineRechargeAddress.findMany({
              where: { active: true, region: String(args.region ?? 'US') },
              orderBy: [{ successCount: 'asc' }, { createdAt: 'desc' }]
            })
          ).map((row) => ({
            ...row,
            line1: row.street,
            postal_code: row.postalCode,
            is_bound: row.successCount > 0 ? 1 : 0
          }))
        );
      case 'getSolverLogs':
        return this.workers.withLease(rpc, async (tx) => ({
          success: true,
          logs: await tx.onlineRechargeEvent.findMany({
            where: {
              OR: [
                { stage: { contains: 'hcaptcha' } },
                { stage: { contains: 'solver' } },
                { message: { contains: '验证码' } }
              ]
            },
            orderBy: { createdAt: 'desc' },
            take: Math.min(200, Math.max(1, Number(args.limit) || 100)),
            select: { createdAt: true, stage: true, message: true }
          })
        }));
      case 'getAppConfigValue': {
        await this.assertLease(rpc);
        if ((args.key ?? args.configKey) !== 'last_used_address_id')
          throw new BadRequestException('配置读取未授权');
        return this.repository.read(
          async (db) =>
            (
              await db.onlineRechargeEvent.findFirst({
                where: { stage: 'last_used_address_id' },
                orderBy: { createdAt: 'desc' }
              })
            )?.message ?? ''
        );
      }
      case 'setAppConfigValue': {
        if ((args.key ?? args.configKey) !== 'last_used_address_id')
          throw new BadRequestException('配置写入未授权');
        return this.workers.withLease(rpc, async (tx, row) =>
          tx.onlineRechargeEvent.create({
            data: { taskId: row.id, stage: 'last_used_address_id', message: id(args.value) }
          })
        );
      }
      case 'proxyTestResult':
        return this.workers.withLease(rpc, async (tx, row) => {
          if (row.operation !== 'proxy_test')
            throw new BadRequestException('当前任务不允许代理检测回报');
          const proxyId = id(args.proxyId);
          const payload = object(row.payload);
          if (
            proxyId !== payload.proxyId &&
            !(Array.isArray(payload.ids) && payload.ids.includes(proxyId))
          )
            throw new BadRequestException('代理检测资料不属于当前任务');
          await tx.onlineRechargeProxy.update({
            where: { id: proxyId },
            data: {
              exitIp: args.ip ? text(args.ip, '出口地址', 100) : null,
              latencyMs:
                typeof args.latencyMs === 'number' ? Math.max(0, Math.round(args.latencyMs)) : null,
              testMessage: args.ok ? '检测成功' : '检测失败',
              testedAt: new Date()
            }
          });
          return { ok: true };
        });
      default:
        throw new BadRequestException('执行器方法未授权');
    }
  }
  private assertLease(rpc: OnlineRechargeWorkerRpc) {
    return this.workers.withLease(rpc, async () => true);
  }
}
