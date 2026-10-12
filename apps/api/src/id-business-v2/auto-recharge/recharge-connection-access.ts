import { ConflictException } from '@nestjs/common';
import { normalizeV2RechargeConnectorUrl } from '@apple-business/shared';
import type { RechargeSettingsService } from './recharge-settings.service';
import { object } from './recharge-validation';

export function assertOriginalRechargeConnection(
  source: Record<string, unknown>,
  current?: Record<string, unknown>
) {
  if (
    (source.connection_api_key && source.connection_api_key !== current?.connection_api_key) ||
    (source.connection_connector_key &&
      source.connection_connector_key !== current?.connection_connector_key)
  )
    throw new ConflictException('请切换到原任务的比特连接配置后复查');
}

export async function readRechargeConnectionAccess(
  job: { ownerId: string; action: string; state: string; result: unknown },
  settings: RechargeSettingsService
) {
  if (job.action !== 'bitbrowser' || job.state === 'finished')
    throw new ConflictException('本次本机任务已结束');
  const snapshot = object(job.result).connection_snapshot_encrypted;
  const access = snapshot
    ? settings.connectionAccess(snapshot)
    : await settings.runtime(job.ownerId, false, false, null);
  return {
    connectorUrl: normalizeV2RechargeConnectorUrl(access.connectorUrl),
    connectorToken: access.connectorToken
  };
}
