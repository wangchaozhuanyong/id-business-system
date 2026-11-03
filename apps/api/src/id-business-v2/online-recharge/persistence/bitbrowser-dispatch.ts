import { ConflictException } from '@nestjs/common';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { resolveBitbrowserConnection } from '../bitbrowser-connection';

export async function selectBitbrowserDevice(
  tx: V2CommandTransaction,
  settings: Record<string, unknown>,
  secrets: Record<string, unknown>
) {
  const device = await tx.onlineRechargeBitbrowserDevice.findUnique({
    where: settings.bitBrowserDeviceId
      ? { id: String(settings.bitBrowserDeviceId) }
      : { slot: 'primary' }
  });
  if (!device?.enabled || !device.tokenHash)
    throw new ConflictException('请先选择已绑定并启用的执行电脑');
  const connection = resolveBitbrowserConnection(
    settings,
    secrets,
    device.id,
    device.slot === 'primary'
  );
  if (!connection) throw new ConflictException('请先配置所选电脑的比特本机接口');
  return { device, connection };
}
