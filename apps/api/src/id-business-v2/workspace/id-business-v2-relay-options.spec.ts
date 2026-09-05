import { ForbiddenException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpException } from '../../common/errors/api-http.exception';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { IdBusinessV2RelayScriptController } from './id-business-v2-relay-script.controller';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import { IdBusinessV2RelayRemoteError } from './providers/id-business-v2-relay-http';

const admin = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function fixture(withRefreshToken = true) {
  const session = {
    access_token: 'fixture-access-token',
    refresh_token: withRefreshToken ? 'fixture-refresh-token' : undefined,
    user: { role: 'admin' }
  };
  const repository = {
    findConnectionByUser: vi.fn().mockResolvedValue({
      id: 'connection-1',
      cloudBridgeSessionEncrypted: 'encrypted-session',
      googleOAuthTokenEncrypted: null
    }),
    updateConnection: vi.fn().mockResolvedValue(undefined)
  };
  const encryption = {
    decrypt: vi.fn(() => JSON.stringify(session)),
    encrypt: vi.fn(() => 'encrypted-refreshed-session')
  };
  const cloudBridge = {
    listGroups: vi.fn().mockResolvedValue([{ id: 12, name: '部署分组', status: 'active' }]),
    listProxies: vi.fn().mockResolvedValue([]),
    listVertexReferences: vi.fn().mockResolvedValue([]),
    listSubscriptionReferences: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue({ access_token: 'fixture-refreshed-token' }),
    validateAdminSession: vi.fn((value) => value)
  };
  const logger = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const service = new IdBusinessV2RelayScriptService(
    repository as never,
    {} as never,
    {} as never,
    encryption as never,
    {} as never,
    {} as never,
    {} as never,
    cloudBridge as never
  );
  return { service, repository, encryption, cloudBridge, logger, session };
}

function remoteError(status?: number, code = 'REMOTE_HTTP_ERROR') {
  return new IdBusinessV2RelayRemoteError('upstream token=private-fixture-secret', code, status);
}

async function failedOptions(service: IdBusinessV2RelayScriptService) {
  const result = await service
    .getDeploymentOptions(admin, 'relay-request-1')
    .catch((error) => error);
  expect(result).toBeInstanceOf(ApiHttpException);
  return result as ApiHttpException;
}

afterEach(() => vi.restoreAllMocks());

describe('relay deployment options recovery', () => {
  it('returns deployment options without refreshing a valid upstream session', async () => {
    const { service, cloudBridge } = fixture();
    await expect(service.getDeploymentOptions(admin)).resolves.toMatchObject({
      geminiGroups: [{ id: 12, label: '部署分组' }],
      antigravityGroups: [{ id: 12, label: '部署分组' }],
      proxies: [],
      billingAccounts: []
    });
    expect(cloudBridge.refresh).not.toHaveBeenCalled();
  });

  it('retries with the refreshed session before reporting a reconnect requirement', async () => {
    const { service, cloudBridge, repository, encryption } = fixture();
    cloudBridge.listProxies.mockRejectedValueOnce(remoteError(401));
    await expect(service.getDeploymentOptions(admin)).resolves.toMatchObject({ proxies: [] });
    expect(cloudBridge.refresh).toHaveBeenCalledExactlyOnceWith('fixture-refresh-token');
    expect(cloudBridge.listProxies).toHaveBeenLastCalledWith('fixture-refreshed-token');
    expect(encryption.encrypt).toHaveBeenCalledWith(
      JSON.stringify({
        access_token: 'fixture-refreshed-token',
        refresh_token: 'fixture-refresh-token',
        user: { role: 'admin' }
      })
    );
    expect(repository.updateConnection).toHaveBeenCalledExactlyOnceWith('connection-1', {
      cloudBridgeSessionEncrypted: 'encrypted-refreshed-session'
    });
  });

  it('reports an expired refresh credential without logging or exposing credential details', async () => {
    const { service, cloudBridge, repository, logger } = fixture();
    cloudBridge.listProxies.mockRejectedValue(remoteError(401));
    cloudBridge.refresh.mockRejectedValue(remoteError(401));
    const error = await failedOptions(service);
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual({
      errorCode: 'RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED',
      message: '中转站登录已失效，自动续期未成功。请到“连接设置”重新连接中转站管理员账号。',
      retryable: false
    });
    expect(logger).toHaveBeenCalledExactlyOnceWith({
      event: 'workspace_relay_options_failed',
      requestId: 'relay-request-1',
      upstreamStatus: 401,
      errorCode: 'REMOTE_HTTP_ERROR'
    });
    expect(JSON.stringify([error.getResponse(), logger.mock.calls])).not.toMatch(/fixture|token=/);
    expect(repository.updateConnection).not.toHaveBeenCalled();
    expect(cloudBridge.refresh).toHaveBeenCalledTimes(1);
  });

  it('requires reconnect when there is no refresh credential', async () => {
    const { service, cloudBridge } = fixture(false);
    cloudBridge.listProxies.mockRejectedValue(remoteError(401));
    const error = await failedOptions(service);
    expect(error.getResponse()).toMatchObject({
      errorCode: 'RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED',
      retryable: false
    });
    expect(cloudBridge.refresh).not.toHaveBeenCalled();
  });

  it('does not log arbitrary upstream envelope codes', async () => {
    const { service, cloudBridge, logger } = fixture();
    cloudBridge.listProxies.mockRejectedValue(
      remoteError(undefined, 'CLOUDBRIDGE_private-fixture-secret')
    );
    await failedOptions(service);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'REMOTE_ERROR' }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private-fixture-secret');
  });

  it('bounds retries when the refreshed access credential is also rejected', async () => {
    const { service, cloudBridge } = fixture();
    cloudBridge.listProxies.mockRejectedValue(remoteError(401));
    const error = await failedOptions(service);
    expect(error.getResponse()).toMatchObject({
      errorCode: 'RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED'
    });
    expect(cloudBridge.refresh).toHaveBeenCalledTimes(1);
    expect(cloudBridge.listProxies).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, 'REMOTE_HTTP_ERROR', 502, 'RELAY_CLOUDBRIDGE_PERMISSION_DENIED', false],
    [429, 'REMOTE_HTTP_ERROR', 429, 'RELAY_CLOUDBRIDGE_RATE_LIMITED', true],
    [503, 'REMOTE_HTTP_ERROR', 502, 'RELAY_CLOUDBRIDGE_OPTIONS_UNAVAILABLE', true],
    [404, 'REMOTE_HTTP_ERROR', 502, 'RELAY_CLOUDBRIDGE_OPTIONS_UNAVAILABLE', false],
    [undefined, 'REMOTE_UNAVAILABLE', 502, 'RELAY_CLOUDBRIDGE_OPTIONS_UNAVAILABLE', true],
    [undefined, 'REMOTE_TIMEOUT', 504, 'RELAY_CLOUDBRIDGE_TIMEOUT', true],
    [undefined, 'REMOTE_RESPONSE_TOO_LARGE', 502, 'RELAY_CLOUDBRIDGE_OPTIONS_UNAVAILABLE', false]
  ])(
    'maps upstream %s/%s into a safe actionable response',
    async (status, code, httpStatus, errorCode, retryable) => {
      const { service, cloudBridge } = fixture();
      cloudBridge.listProxies.mockRejectedValue(remoteError(status, code));
      const error = await failedOptions(service);
      expect(error.getStatus()).toBe(httpStatus);
      expect(error.getResponse()).toMatchObject({ errorCode, retryable });
      expect(JSON.stringify(error.getResponse())).not.toContain('private-fixture-secret');
      expect(cloudBridge.refresh).not.toHaveBeenCalled();
    }
  );

  it('keeps a temporary refresh outage retryable instead of asking for a new login', async () => {
    const { service, cloudBridge } = fixture();
    cloudBridge.listProxies.mockRejectedValue(remoteError(401));
    cloudBridge.refresh.mockRejectedValue(remoteError(undefined, 'REMOTE_TIMEOUT'));
    const error = await failedOptions(service);
    expect(error.getResponse()).toMatchObject({
      errorCode: 'RELAY_CLOUDBRIDGE_TIMEOUT',
      retryable: true
    });
  });

  it('preserves the response envelope and request ID without invalidating the ID system session', async () => {
    const { service, cloudBridge } = fixture();
    cloudBridge.listProxies.mockRejectedValue(remoteError(401));
    cloudBridge.refresh.mockRejectedValue(remoteError(401));
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: 'relay-request-1' }),
        getResponse: () => ({ setHeader: vi.fn(), status })
      })
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(await failedOptions(service), host);
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED',
        requestId: 'relay-request-1',
        retryable: false
      })
    );
  });

  it('preserves local permission checks and unrelated programming errors', async () => {
    const { service, cloudBridge, repository } = fixture();
    await expect(
      service.getDeploymentOptions({ ...admin, roles: ['member'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findConnectionByUser).not.toHaveBeenCalled();
    const unexpected = new TypeError('unexpected implementation error');
    cloudBridge.listProxies.mockRejectedValue(unexpected);
    await expect(service.getDeploymentOptions(admin)).rejects.toBe(unexpected);
  });

  it('passes request correlation from the controller to the options service', async () => {
    const getDeploymentOptions = vi.fn().mockResolvedValue({});
    const controller = new IdBusinessV2RelayScriptController(
      { getDeploymentOptions } as never,
      {} as never,
      {} as never,
      {} as never
    );
    await controller.options(admin, { requestId: 'relay-request-1' });
    expect(getDeploymentOptions).toHaveBeenCalledExactlyOnceWith(admin, 'relay-request-1');
  });
});
