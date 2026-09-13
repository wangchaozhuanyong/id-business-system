const failureMessages = {
  unreachable:
    '网页无法访问本机连接器。请检查连接器是否运行，以及 Chrome 对当前网站的本机网络访问权限或拦截规则。',
  timeout: '本机连接检测超时，请检查连接器和比特浏览器是否正常响应。',
  origin: '本机连接器未允许当前网站来源，请核对连接器的允许来源设置。',
  credentials: '本机连接密钥不匹配，请在设置中更新为当前连接器的密钥。',
  version: '本机连接器版本过旧，请先更新并重启连接器，再检测连接。',
  protocol: '该地址返回的不是可用的自动充值连接器，请核对连接器地址与端口。',
  busy: '本机连接器还有任务未结束，请先处理原任务。',
  bitbrowser:
    '连接器已连通，但比特浏览器接口不可用。请检查比特浏览器是否启动、接口地址和接口密钥。',
  rejected: '本机连接器拒绝了请求，请检查连接配置。',
  missing: '本机连接器中没有此任务。',
  cancelled: '本次连接检测已取消。'
};
type FailureCode = keyof typeof failureMessages;
export class RechargeConnectorError extends Error {
  constructor(readonly code: FailureCode) {
    super(failureMessages[code]);
    this.name = 'RechargeConnectorError';
  }
}

const reasons: Record<string, FailureCode> = {
  connector_origin_not_allowed: 'origin',
  connector_token_invalid: 'credentials',
  bitbrowser_api_token_invalid: 'bitbrowser',
  bitbrowser_local_api_unavailable: 'bitbrowser',
  bitbrowser_local_api_rejected: 'bitbrowser',
  another_local_job_is_running: 'busy',
  invalid_bitbrowser_configuration: 'rejected'
};

export async function connectorRequest(
  connectorUrl: string,
  path: string,
  options: {
    token?: string;
    body?: object;
    method?: 'GET' | 'POST';
    signal?: AbortSignal;
    timeout?: number;
  } = {}
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(options.timeout ?? 15_000);
  let response: Response;
  try {
    response = await fetch(connectorUrl.replace(/\/$/, '') + path, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { 'X-Auto-Recharge-Connector': options.token } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])])
    });
  } catch {
    throw new RechargeConnectorError(
      options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'unreachable'
    );
  }
  let result: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    result = value as Record<string, unknown>;
  } catch {
    throw new RechargeConnectorError(timeout.aborted ? 'timeout' : 'protocol');
  }
  if (!response.ok || result.ok !== true) {
    const reason =
      typeof result.reason === 'string' && Object.hasOwn(reasons, result.reason)
        ? reasons[result.reason]
        : undefined;
    throw new RechargeConnectorError(
      reason ??
        (response.status === 401 || response.status === 403
          ? 'credentials'
          : response.status === 404
            ? 'missing'
            : 'rejected')
    );
  }
  return result;
}

export function requireConnectorHealth(result: Record<string, unknown>) {
  if (result.service !== 'id-business-v2-auto-recharge-connector' || result.version !== 2) {
    throw new RechargeConnectorError(
      typeof result.version === 'number' && result.version < 2 ? 'version' : 'protocol'
    );
  }
  if (result.originAllowed !== true) throw new RechargeConnectorError('origin');
  if (result.busy !== false) throw new RechargeConnectorError('busy');
  if (
    !Array.isArray(result.capabilities) ||
    !['browser-catalog', 'browser-options', 'session-load-retry'].every((key) =>
      (result.capabilities as unknown[]).includes(key)
    )
  ) {
    throw new RechargeConnectorError('version');
  }
  return result;
}
