import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';
import { RechargeSettingsService } from './recharge-settings.service';
import { hash, object, uuidPattern } from './recharge-validation';
import {
  validateRechargeBitBrowserRecheckStart,
  validateRechargeBitBrowserStart
} from './recharge-local-validation';

@Injectable()
export class RechargeLocalService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly addressRepository: RechargeAddressRepository,
    private readonly settings: RechargeSettingsService,
    private readonly recharge: RechargeService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async start(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeBitBrowserStart(value);
    const runtime = await this.settings.runtime(operator.id);
    const agentToken = randomBytes(32).toString('hex');
    const result = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const previous = await this.repository.findJob(tx, input.id);
        if (previous) throw new ConflictException('本次连接凭据已失效，请重新开始');
        const active = await this.repository.findRunningJob(tx);
        if (active) throw new ConflictException('已有一笔充值任务执行中');
        const address = await this.addressRepository.requireUnused(
          tx,
          operator.id,
          input.addressId
        );
        const job = await this.repository.createJob(tx, {
          id: input.id,
          ownerId: operator.id,
          plan: input.plan,
          action: 'bitbrowser',
          state: 'running',
          nonceHash: hash(agentToken),
          leaseUntil: new Date(Date.now() + 45 * 60000),
          result: toV2JsonDocument({
            status: 'waiting_local_connector',
            stage: 'connector_dispatch',
            addressId: address.id,
            window_name: input.windowName,
            locked_currency: input.lockedCurrency,
            max_amount: input.maxAmount,
            payment_requests_sent: 0
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser.start',
          objectType: 'recharge_job',
          objectId: job.id,
          afterData: {
            plan: input.plan,
            addressId: address.id,
            windowName: input.windowName,
            lockedCurrency: input.lockedCurrency,
            maxAmount: input.maxAmount,
            authorizeSinglePayment: true
          },
          remark: '创建本机比特浏览器单次充值任务'
        });
        return { job, address };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: input.id,
        operator,
        retryMode: 'none'
      }
    );

    return {
      id: result.job.id,
      mode: 'payment' as const,
      connectorUrl: runtime.connectorUrl,
      connectorToken: runtime.connectorToken,
      agentToken,
      bitBrowser: {
        localApiUrl: runtime.localApiUrl,
        localApiToken: runtime.localApiToken,
        groupName: runtime.groupName,
        tagName: runtime.tagName,
        proxyType: runtime.proxyType,
        dynamicProxyUrl: runtime.dynamicProxyUrl
      },
      address: {
        id: result.address.id,
        line1: result.address.line1,
        country: result.address.country,
        city: result.address.city,
        state: result.address.state,
        postalCode: result.address.postalCode
      },
      safety: {
        lockedCurrency: input.lockedCurrency,
        maxAmount: input.maxAmount,
        maxAmountMinor: input.maxAmountMinor,
        authorizeSinglePayment: true
      }
    };
  }

  async recheck(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeBitBrowserRecheckStart(value);
    const runtime = await this.settings.runtime(operator.id);
    const agentToken = randomBytes(32).toString('hex');
    const job = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        if (await this.repository.findJob(tx, input.id)) {
          throw new ConflictException('本次连接凭据已失效，请重新开始');
        }
        if (await this.repository.findRunningJob(tx)) {
          throw new ConflictException('已有一笔充值任务执行中');
        }
        const source = await this.repository.findJob(tx, input.sourceJobId);
        const sourceResult = source ? object(source.result) : {};
        const paymentAttempted =
          sourceResult.payment_attempted === true ||
          Number(sourceResult.payment_requests_sent) === 1 ||
          Number(sourceResult.confirmation_requests_sent) === 1;
        if (
          !source ||
          source.ownerId !== operator.id ||
          source.plan !== input.plan ||
          !['prepare', 'flow', 'bitbrowser', 'recheck'].includes(source.action) ||
          !paymentAttempted ||
          sourceResult.recheck_only === true ||
          sourceResult.payment_status === 'declined' ||
          sourceResult.status === 'subscription_activated' ||
          sourceResult.payment_outcome === 'subscription_activated'
        ) {
          throw new ConflictException('该记录不能只读复查原订单');
        }
        const created = await this.repository.createJob(tx, {
          id: input.id,
          ownerId: operator.id,
          plan: input.plan,
          action: 'bitbrowser',
          state: 'running',
          nonceHash: hash(agentToken),
          leaseUntil: new Date(Date.now() + 45 * 60000),
          result: toV2JsonDocument({
            status: 'waiting_local_connector',
            stage: 'connector_dispatch',
            window_name: input.windowName,
            recheck_only: true,
            payment_attempted: true,
            payment_status: 'unknown',
            payment_requests_sent: 0
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser.recheck',
          objectType: 'recharge_job',
          objectId: created.id,
          afterData: {
            sourceJobId: source.id,
            plan: input.plan,
            windowName: input.windowName,
            recheckOnly: true
          },
          remark: '使用本机比特浏览器只读复查原订单'
        });
        return created;
      },
      { changedScopes: ['auto-recharge'], requestId: input.id, operator, retryMode: 'none' }
    );

    return {
      id: job.id,
      mode: 'recheck' as const,
      connectorUrl: runtime.connectorUrl,
      connectorToken: runtime.connectorToken,
      agentToken,
      bitBrowser: {
        localApiUrl: runtime.localApiUrl,
        localApiToken: runtime.localApiToken,
        groupName: runtime.groupName,
        tagName: runtime.tagName,
        proxyType: runtime.proxyType,
        dynamicProxyUrl: runtime.dynamicProxyUrl
      }
    };
  }

  async callback(id: string, token: unknown, value: unknown) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    const job = await this.repository.byId(id);
    if (job.action !== 'bitbrowser' || !job.nonceHash || typeof token !== 'string') {
      throw new ForbiddenException('本机连接凭据无效');
    }
    const actual = hash(token);
    if (
      actual.length !== job.nonceHash.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(job.nonceHash))
    ) {
      throw new ForbiddenException('本机连接凭据无效');
    }
    return this.recharge.callback(id, value);
  }

  async access(id: string, operator: AuthenticatedUser) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    const job = await this.repository.owned(id, operator.id);
    if (job.action !== 'bitbrowser' || job.state === 'finished') {
      throw new ConflictException('本次本机任务已结束');
    }
    const runtime = await this.settings.runtime(operator.id);
    return { connectorUrl: runtime.connectorUrl, connectorToken: runtime.connectorToken };
  }

  async abandonUnreceived(id: string, operator: AuthenticatedUser) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findJob(tx, id);
        const current = job ? object(job.result) : {};
        if (!job || job.ownerId !== operator.id || job.action !== 'bitbrowser') {
          throw new ForbiddenException('无权操作此任务');
        }
        if (
          job.state !== 'running' ||
          current.status !== 'waiting_local_connector' ||
          current.stage !== 'connector_dispatch' ||
          current.payment_attempted === true ||
          Number(current.payment_requests_sent) > 0
        ) {
          throw new ConflictException('本机任务已接收或已开始，只能刷新原任务');
        }
        await this.repository.updateJob(tx, id, {
          state: 'finished',
          nonceHash: null,
          leaseUntil: new Date(),
          result: toV2JsonDocument({
            ...current,
            status: 'blocked',
            reason: 'local_connector_not_received',
            payment_attempted: false,
            payment_requests_sent: 0
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser.unreceived',
          objectType: 'recharge_job',
          objectId: id,
          remark: '本机连接器未接收，安全结束任务'
        });
        return { id };
      },
      { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
    );
  }

  async cancel(id: string, operator: AuthenticatedUser) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.active(tx, id);
        if (job.ownerId !== operator.id || job.action !== 'bitbrowser') {
          throw new ForbiddenException('无权操作此任务');
        }
        const current = object(job.result);
        if (current.payment_attempted === true || Number(current.payment_requests_sent) > 0) {
          throw new ConflictException('官网付款请求已发出，只能查看原单结果');
        }
        await this.repository.updateJob(tx, id, {
          state: 'finished',
          nonceHash: null,
          leaseUntil: new Date(),
          result: toV2JsonDocument({
            ...current,
            status: 'cancelled',
            reason: 'operation_cancelled',
            payment_requests_sent: 0
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser.cancel',
          objectType: 'recharge_job',
          objectId: id,
          remark: '停止本机比特浏览器充值任务'
        });
        return { id };
      },
      { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
    );
  }
}
