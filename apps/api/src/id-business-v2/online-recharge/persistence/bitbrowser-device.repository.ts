import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { id, object, text } from '../validation';
import { BITBROWSER_PROTOCOL } from '../bitbrowser-policy';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function matches(value: unknown, expected: string | null) {
  if (
    typeof value !== 'string' ||
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    value.length > 200
  )
    return false;
  return timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expected));
}
@Injectable()
export class OnlineBitbrowserDeviceRepository {
  constructor(private readonly repository: OnlineRechargeRepository) {}
  async list() {
    const [devices, tasks] = await this.repository.read((db) =>
      Promise.all([
        db.onlineRechargeBitbrowserDevice.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 20
        }),
        db.onlineRechargeTask.findMany({
          where: { provider: 'bitbrowser', status: 'running' },
          select: { id: true, stage: true, payload: true },
          take: 20
        })
      ])
    );
    return {
      items: devices.map((device) => ({
        id: device.id,
        name: device.name,
        enabled: device.enabled,
        paired: Boolean(device.tokenHash),
        online:
          device.enabled &&
          Boolean(device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() < 30000),
        ready: device.ready,
        busy: device.busy,
        protocol: device.protocol,
        lastSeenAt: device.lastSeenAt,
        pairingExpiresAt: device.pairingExpiresAt,
        activeTask: (() => {
          const task = tasks.find(
            (row) => object(object(row.payload).bitBrowserPolicy ?? {}).deviceId === device.id
          );
          return task ? { id: task.id, stage: task.stage } : null;
        })()
      }))
    };
  }
  async summary() {
    const row = await this.repository.read((db) =>
      db.onlineRechargeBitbrowserDevice.findUnique({ where: { slot: 'primary' } })
    );
    const activeTask = row
      ? await this.repository.read((db) =>
          db.onlineRechargeTask.findFirst({
            where: {
              provider: 'bitbrowser',
              status: 'running',
              payload: { path: '$.bitBrowserPolicy.deviceId', equals: row.id }
            },
            select: { id: true, stage: true }
          })
        )
      : null;
    return row
      ? {
          activeTask,
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          paired: Boolean(row.tokenHash),
          online:
            row.enabled && Boolean(row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 30000),
          ready: row.ready,
          busy: row.busy,
          protocol: row.protocol,
          lastSeenAt: row.lastSeenAt,
          pairingExpiresAt: row.pairingExpiresAt
        }
      : null;
  }
  pairing(raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw),
      name = text(input.name, '执行电脑名称', 80);
    const requestedId = input.deviceId ? id(input.deviceId) : undefined;
    const token = randomBytes(32).toString('base64url');
    return this.repository.transaction('bitbrowser-device', async (tx) => {
      const existing = requestedId
        ? await tx.onlineRechargeBitbrowserDevice.findUnique({ where: { id: requestedId } })
        : null;
      if (requestedId && !existing) throw new ConflictException('所选执行电脑不存在');
      if (
        requestedId &&
        (await tx.onlineRechargeTask.count({
          where: {
            provider: 'bitbrowser',
            status: 'running',
            payload: { path: '$.bitBrowserPolicy.deviceId', equals: requestedId }
          }
        }))
      )
        throw new ConflictException('比特任务正在运行，请完成或核对原任务后再绑定电脑');
      const expiresAt = new Date(Date.now() + 10 * 60000);
      const primary = !existing
        ? await tx.onlineRechargeBitbrowserDevice.findUnique({ where: { slot: 'primary' } })
        : null;
      if (!existing && (await tx.onlineRechargeBitbrowserDevice.count()) >= 20)
        throw new ConflictException('执行电脑数量已达上限，请复用已有电脑重新配对');
      const data = { name, pairingHash: digest(token), pairingExpiresAt: expiresAt };
      const device = existing
        ? await tx.onlineRechargeBitbrowserDevice.update({ where: { id: existing.id }, data })
        : await tx.onlineRechargeBitbrowserDevice.create({
            data: {
              id: randomUUID(),
              slot: primary ? randomBytes(8).toString('hex') : 'primary',
              ...data
            }
          });
      await this.repository.log(tx, 'bitbrowser.pairing.create', operator, device.id);
      return { deviceId: device.id, pairingToken: token, expiresAt };
    });
  }
  async pair(raw: unknown) {
    const input = object(raw),
      token = text(input.pairingToken, '配对凭据', 200);
    return this.repository.transaction('bitbrowser-device', async (tx) => {
      const device = await tx.onlineRechargeBitbrowserDevice.findUnique({
        where: { pairingHash: digest(token) }
      });
      if (!device || !device.pairingExpiresAt || device.pairingExpiresAt.getTime() <= Date.now())
        throw new UnauthorizedException('配对凭据无效或已过期');
      if (
        await tx.onlineRechargeTask.count({
          where: {
            provider: 'bitbrowser',
            status: 'running',
            payload: { path: '$.bitBrowserPolicy.deviceId', equals: device.id }
          }
        })
      )
        throw new ConflictException('比特任务正在运行，暂不能更换连接凭据');
      const key = randomBytes(32).toString('base64url');
      await tx.onlineRechargeBitbrowserDevice.update({
        where: { id: device.id },
        data: {
          tokenHash: digest(key),
          pairingHash: null,
          pairingExpiresAt: null,
          enabled: true,
          protocol: BITBROWSER_PROTOCOL,
          ready: false,
          busy: false,
          lastSeenAt: new Date()
        }
      });
      await this.repository.log(tx, 'bitbrowser.paired', undefined, device.id);
      return { deviceId: device.id, deviceKey: key, protocol: BITBROWSER_PROTOCOL };
    });
  }
  async authorize(deviceId: unknown, token: unknown) {
    const row = await this.repository.read((db) =>
      db.onlineRechargeBitbrowserDevice.findUnique({ where: { id: id(deviceId) } })
    );
    if (!row || !row.enabled || !matches(token, row.tokenHash))
      throw new UnauthorizedException('执行电脑凭据无效或已停用');
    return row;
  }
  revoke(operator: AuthenticatedUser, deviceId?: unknown) {
    return this.repository.transaction('bitbrowser-device', async (tx) => {
      const row = await tx.onlineRechargeBitbrowserDevice.findUnique({
        where: deviceId ? { id: id(deviceId) } : { slot: 'primary' }
      });
      if (row) {
        await tx.onlineRechargeBitbrowserDevice.update({
          where: { id: row.id },
          data: {
            enabled: false,
            tokenHash: null,
            pairingHash: null,
            pairingExpiresAt: null,
            ready: false
          }
        });
        await this.repository.log(tx, 'bitbrowser.device.revoke', operator, row.id);
      }
      return { ok: true };
    });
  }
}
