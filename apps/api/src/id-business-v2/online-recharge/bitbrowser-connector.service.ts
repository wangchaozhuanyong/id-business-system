import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { OnlineRechargeBitbrowserDevice } from '@prisma/client';
import { toV2JsonDocument } from '../runtime/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';
import { OnlineBitbrowserDeviceRepository } from './persistence/bitbrowser-device.repository';
import { OnlineBitbrowserConnectionsRepository } from './persistence/bitbrowser-connections.repository';
import { OnlineBitbrowserPaymentRepository } from './persistence/bitbrowser-payment.repository';
import { OnlineBitbrowserCompletionService } from './bitbrowser-completion.service';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { BITBROWSER_PLAN, BITBROWSER_PROTOCOL } from './bitbrowser-policy';
import type { OnlineRechargeWorkerRpc } from './contracts';
import { id, integer, object, text } from './validation';

@Injectable()
export class OnlineBitbrowserConnectorService {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly devices: OnlineBitbrowserDeviceRepository,
    private readonly payments: OnlineBitbrowserPaymentRepository,
    private readonly completion: OnlineBitbrowserCompletionService,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly workerRpc: OnlineRechargeWorkerRpcRepository,
    private readonly credentials: OnlineRechargeEphemeralCredentials,
    private readonly encryption: FieldEncryptionService,
    private readonly connections: OnlineBitbrowserConnectionsRepository
  ) {}
  async rpc(key: unknown, raw: unknown) {
    const input = object(raw),
      args = object(input.args ?? {});
    const device = await this.devices.authorize(input.deviceId, key);
    const method = text(input.method, '连接器方法', 40);
    if (method === 'heartbeat') {
      if (
        args.protocol !== BITBROWSER_PROTOCOL ||
        typeof args.ready !== 'boolean' ||
        typeof args.busy !== 'boolean'
      )
        throw new BadRequestException('连接器协议或状态无效，请更新本机助手');
      await this.repository.transaction('bitbrowser-device', async (tx) => {
        await tx.onlineRechargeBitbrowserDevice.updateMany({
          where: { id: device.id, tokenHash: device.tokenHash, enabled: true },
          data: {
            lastSeenAt: new Date(),
            ready: args.ready as boolean,
            busy: args.busy as boolean,
            protocol: BITBROWSER_PROTOCOL
          }
        });
      });
      return { ok: true };
    }
    if (method === 'connection') {
      return (
        (await this.connections.privateConnection(device.id)) ?? {
          localApiUrl: '',
          localApiToken: '',
          groupName: '',
          tagName: ''
        }
      );
    }
    if (method === 'claim') {
      if (
        !device.ready ||
        device.busy ||
        device.protocol !== BITBROWSER_PROTOCOL ||
        !device.lastSeenAt ||
        Date.now() - device.lastSeenAt.getTime() > 30000
      )
        return null;
      const task = await this.workers.claim(`bitbrowser:${device.id}`, device.id);
      if (!task) return null;
      return {
        id: task.id,
        plan: task.plan,
        leaseId: task.leaseId,
        leaseVersion: task.leaseVersion,
        leaseExpiresAt: task.leaseExpiresAt
      };
    }
    const rpc: OnlineRechargeWorkerRpc = {
      method,
      taskId: id(input.taskId),
      workerId: `bitbrowser:${device.id}`,
      leaseId: id(input.leaseId),
      leaseVersion: integer(input.leaseVersion, '租约版本', 1, 1000000),
      args
    };
    if (method === 'callback' && args.type === 'finished') {
      const prior = await this.repository.read((db) =>
        db.onlineRechargeTask.findUnique({ where: { id: rpc.taskId } })
      );
      if (
        prior?.provider === 'bitbrowser' &&
        !prior.leaseOwner &&
        prior.leaseVersion === rpc.leaseVersion &&
        ['succeeded', 'failed', 'awaiting_review'].includes(prior.status) &&
        object(object(prior.payload).bitBrowserPolicy).deviceId === device.id
      )
        return { ok: true, status: prior.status, replayed: true };
    }
    await this.workers.withLease(rpc, async (tx, row) => {
      await this.payments.owned(tx, row, device);
    });
    if (method === 'lease') {
      const heartbeat = await this.workers.heartbeat(rpc);
      const resumeVersion = await this.workers.withLease(rpc, async (_tx, row) =>
        object(row.payload).bitBrowserResumeLeaseVersion === row.leaseVersion
          ? Number(object(row.payload).bitBrowserResumeVersion ?? 0)
          : 0
      );
      return { ...heartbeat, resumeVersion };
    }
    if (method === 'prepare') return this.prepare(rpc, device);
    if (method === 'quote') return this.payments.quote(rpc, device);
    if (method === 'quote-status') return this.payments.status(rpc, device);
    if (method === 'release') return this.payments.release(rpc, device);
    if (method === 'callback') {
      if (args.type === 'restore') return this.payments.restore(rpc, device);
      if (args.type === 'ledger') return this.payments.ledger(rpc, device);
      if (args.type === 'finished') return this.completion.finish(rpc, device);
      if (args.type === 'progress') {
        const result = object(args.result ?? {});
        const rawStage = typeof result.stage === 'string' ? result.stage : '';
        const stage =
          result.user_action_required === true && result.status !== 'awaiting_confirmation'
            ? 'bitbrowser_verification'
            : /payment|upgrade|confirmation/.test(rawStage)
              ? 'bitbrowser_payment'
              : /checkout|quote|plan/.test(rawStage)
                ? 'bitbrowser_quote'
                : /session|login|account/.test(rawStage)
                  ? 'bitbrowser_login'
                  : 'bitbrowser_preparing';
        const messages: Record<string, string> = {
          bitbrowser_verification: '等待执行电脑完成人工验证',
          bitbrowser_payment: '正在处理本次付款',
          bitbrowser_quote: '正在核对套餐与报价',
          bitbrowser_login: '正在登录并核对账号',
          bitbrowser_preparing: '正在准备比特浏览器与代理'
        };
        await this.workers.withLease(rpc, async (tx, row) => {
          await tx.onlineRechargeTask.update({
            where: { id: row.id },
            data: {
              result: toV2JsonDocument({
                ...object(row.result ?? {}),
                bitBrowserUserAction:
                  result.user_action_required === true && result.status !== 'awaiting_confirmation'
              })
            }
          });
        });
        return this.workers.progress({ ...rpc, args: { stage, message: messages[stage] } });
      }
    }
    throw new BadRequestException('连接器方法未授权');
  }
  private async prepare(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    const owned = await this.workers.withLease(rpc, async (tx, row) => ({
      row,
      state: await this.payments.owned(tx, row, device)
    }));
    if (object(owned.row.payload).bitBrowserCheckOnly === true) {
      await this.workers.heartbeat(rpc);
      const records = owned.state.ledgerEncrypted
        ? object(JSON.parse(this.encryption.decrypt(owned.state.ledgerEncrypted)!))
        : {};
      const upgrade = Object.values(records)
        .map((value) => object(object(value).document))
        .find(
          (record) =>
            record.operation === 'subscription_upgrade' && record.confirmation_requests_sent === 1
        );
      const payload = object(owned.row.payload);
      return {
        checkOnly: true,
        accountKey: owned.state.accountKey,
        ...(upgrade ? { upgradeIdentifier: upgrade.upgrade_identifier } : {}),
        plan: BITBROWSER_PLAN[owned.row.plan],
        sessionJson: this.encryption.decrypt(owned.row.sessionEncrypted),
        connection: object(
          JSON.parse(this.encryption.decrypt(String(payload.bitBrowserConnectionEncrypted))!)
        ),
        policy: object(payload.bitBrowserPolicy),
        proxy: await this.workerRpc.dispatch({ ...rpc, method: 'getActiveProxy', args: {} })
      };
    }
    const card = object((await this.workers.reserveCard(rpc)) ?? {});
    if (card.pendingCredentials) {
      await this.workers.finish({ ...rpc, args: { status: 'awaiting_credentials' } }, false);
      return { pendingCredentials: true };
    }
    if (!card.id) throw new ConflictException('没有适用且可用的银行卡');
    const cvc = await this.credentials.claimCvc(String(card.id), rpc.taskId!);
    if (!cvc) {
      await this.workers.finish({ ...rpc, args: { status: 'awaiting_credentials' } }, false);
      return { pendingCredentials: true };
    }
    const row = await this.workers.withLease(rpc, async (tx, task) => {
      await this.payments.owned(tx, task, device);
      return task;
    });
    const payload = object(row.payload),
      policy = object(payload.bitBrowserPolicy);
    const proxy = await this.workerRpc.dispatch({ ...rpc, method: 'getActiveProxy', args: {} });
    const addresses = (await this.workerRpc.dispatch({
      ...rpc,
      method: 'listAddresses',
      args: { region: 'US' }
    })) as Record<string, unknown>[];
    const address = addresses.find((value) => value.id === card.address_id) ?? addresses[0];
    if (!address) throw new ConflictException('没有可用账单地址，请先补充地址资源');
    await this.workers.withLease(rpc, async (tx, task) => {
      await tx.onlineRechargeTask.update({
        where: { id: task.id },
        data: {
          payload: toV2JsonDocument({
            ...object(task.payload),
            bitBrowserAddressId: address.id
          })
        }
      });
    });
    const connection = object(
      JSON.parse(this.encryption.decrypt(String(payload.bitBrowserConnectionEncrypted))!)
    );
    return {
      id: row.id,
      plan: BITBROWSER_PLAN[row.plan],
      sessionJson: this.encryption.decrypt(row.sessionEncrypted),
      connection,
      policy,
      proxy,
      details: {
        number: card.card_number,
        expiry: card.card_expiry,
        cvc,
        name: card.card_holder || `${address.firstName} ${address.lastName}`,
        email: this.encryption.decrypt(row.emailEncrypted)
      },
      address: {
        id: address.id,
        country: address.country,
        line1: address.street,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode
      }
    };
  }
}
