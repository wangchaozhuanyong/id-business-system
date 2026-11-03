import { BadRequestException } from '@nestjs/common';
import { ONLINE_RECHARGE_DEFAULTS } from './contracts';
import { validateBitbrowserSettings } from './bitbrowser-policy';
import { object, text } from './validation';

export const deviceConnectionKey = (deviceId: string) => `bitBrowserDeviceConnection_${deviceId}`;
export interface BitbrowserConnection {
  localApiUrl: string;
  localApiToken: string;
  groupName: string;
  tagName: string;
}
export function validateBitbrowserConnection(
  value: unknown,
  previousToken = ''
): BitbrowserConnection {
  const input = object(value);
  const connection = {
    localApiUrl: text(input.localApiUrl, '比特本机接口', 200),
    localApiToken: input.localApiToken
      ? text(input.localApiToken, '比特接口密钥', 4096)
      : previousToken,
    groupName: text(input.groupName, '比特分组名称', 80),
    tagName: text(input.tagName, '比特标签名称', 80)
  };
  validateBitbrowserSettings({
    ...ONLINE_RECHARGE_DEFAULTS,
    bitBrowserApiUrl: connection.localApiUrl
  });
  if (connection.localApiToken.length < 16)
    throw new BadRequestException('请填写本台电脑的有效比特接口密钥');
  return connection;
}
export function resolveBitbrowserConnection(
  settings: Record<string, unknown>,
  secrets: Record<string, unknown>,
  deviceId: string,
  legacy: boolean
): BitbrowserConnection | null {
  const stored = secrets[deviceConnectionKey(deviceId)];
  if (typeof stored === 'string') return validateBitbrowserConnection(JSON.parse(stored));
  if (!legacy || !secrets.bitBrowserApiKey) return null;
  return validateBitbrowserConnection({
    localApiUrl: settings.bitBrowserApiUrl,
    localApiToken: secrets.bitBrowserApiKey,
    groupName: settings.bitBrowserGroupName,
    tagName: settings.bitBrowserTagName
  });
}
