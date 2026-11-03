import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { ONLINE_RECHARGE_DEFAULTS } from '../contracts';
import {
  deviceConnectionKey,
  resolveBitbrowserConnection,
  validateBitbrowserConnection
} from '../bitbrowser-connection';
import { id, integer, object } from '../validation';

@Injectable()
export class OnlineBitbrowserConnectionsRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly encryption: FieldEncryptionService
  ) {}
  private async configuration(deviceId: string) {
    const [device, config] = await this.repository.read((db) =>
      Promise.all([
        db.onlineRechargeBitbrowserDevice.findUnique({ where: { id: id(deviceId) } }),
        db.onlineRechargeConfig.findUnique({ where: { id: 'global' } })
      ])
    );
    if (!device) throw new NotFoundException('执行电脑不存在');
    const secrets = config?.secretsEncrypted
      ? object(JSON.parse(this.encryption.decrypt(config.secretsEncrypted)!))
      : {};
    return {
      connection: resolveBitbrowserConnection(
        { ...ONLINE_RECHARGE_DEFAULTS, ...object(config?.settings ?? {}) },
        secrets,
        device.id,
        device.slot === 'primary'
      ),
      version: config?.version ?? 0
    };
  }
  async privateConnection(deviceId: string) {
    return (await this.configuration(deviceId)).connection;
  }
  async read(deviceId: string) {
    const { connection, version } = await this.configuration(deviceId);
    return {
      version,
      localApiUrl: connection?.localApiUrl ?? ONLINE_RECHARGE_DEFAULTS.bitBrowserApiUrl,
      groupName: connection?.groupName ?? ONLINE_RECHARGE_DEFAULTS.bitBrowserGroupName,
      tagName: connection?.tagName ?? ONLINE_RECHARGE_DEFAULTS.bitBrowserTagName,
      secretSaved: Boolean(connection?.localApiToken)
    };
  }
  save(deviceId: string, value: unknown, operator: AuthenticatedUser) {
    return this.repository.transaction('config', async (tx) => {
      const device = await tx.onlineRechargeBitbrowserDevice.findUnique({
        where: { id: id(deviceId) }
      });
      if (!device) throw new NotFoundException('执行电脑不存在');
      const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
      if (!config) throw new ConflictException('请先保存系统基础配置');
      const secrets = config.secretsEncrypted
        ? object(JSON.parse(this.encryption.decrypt(config.secretsEncrypted)!))
        : {};
      const current = resolveBitbrowserConnection(
        { ...ONLINE_RECHARGE_DEFAULTS, ...object(config.settings) },
        secrets,
        device.id,
        device.slot === 'primary'
      );
      const input = object(value);
      if (integer(input.version, '配置版本', 0, 1000000) !== config.version)
        throw new ConflictException('设置已变化，请刷新后重新保存');
      const connection = validateBitbrowserConnection(input, current?.localApiToken);
      await tx.onlineRechargeConfig.update({
        where: { id: 'global' },
        data: {
          secretsEncrypted: this.encryption.encrypt(
            JSON.stringify({
              ...secrets,
              [deviceConnectionKey(device.id)]: JSON.stringify(connection)
            })
          ),
          version: { increment: 1 }
        }
      });
      await this.repository.log(tx, 'bitbrowser.connection.update', operator, device.id);
      return { ok: true };
    });
  }
}
