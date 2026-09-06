import { afterEach, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service';
import { IS_PUBLIC_KEY, ALLOW_DURING_PASSWORD_RESET_KEY } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  BROWSER_SESSION_COOKIE_NAME,
  readBrowserSessionToken
} from '../auth/browser-session-cookie';
import { V2AuthController } from './v2-auth.controller';

const user: AuthenticatedUser = {
  id: 'test-user',
  username: 'test',
  displayName: '测试用户',
  roles: [],
  permissions: [],
  mustResetPassword: false
};

function fixture() {
  const service = {
    login: vi.fn().mockResolvedValue({ accessToken: 'test-token', user }),
    logout: vi.fn().mockResolvedValue({ loggedOut: true }),
    changePassword: vi.fn().mockResolvedValue({ passwordChanged: true, signedOut: true })
  };
  const request = {
    method: 'GET',
    originalUrl: '/api/auth/session',
    headers: { 'sec-fetch-site': 'same-origin', authorization: 'Bearer test-token' }
  };
  const response = { setHeader: vi.fn() };
  return {
    service,
    request,
    response,
    controller: new V2AuthController(service as unknown as AuthService)
  };
}

describe('browser session lifecycle', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sets a host-only, HttpOnly, secure session cookie after successful same-origin login', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { controller, request, response } = fixture();
    await controller.login({ username: 'test', password: 'test-only-password' }, request, response);
    const cookie = response.setHeader.mock.calls[0]?.[1] as string;
    expect(cookie).toBe(
      `${BROWSER_SESSION_COOKIE_NAME}=test-token; Path=/api/auth/session; HttpOnly; SameSite=Strict; Secure`
    );
    expect(cookie).not.toMatch(/Domain=|Expires=|Max-Age=/);
  });

  it('does not set a cookie after failed or cross-origin login', async () => {
    const { controller, service, request, response } = fixture();
    service.login.mockRejectedValueOnce(new Error('rejected'));
    await expect(
      controller.login({ username: 'test', password: 'invalid' }, request, response)
    ).rejects.toThrow('rejected');
    expect(response.setHeader).not.toHaveBeenCalled();
    request.headers['sec-fetch-site'] = 'same-site';
    await controller.login({ username: 'test', password: 'test-only-password' }, request, response);
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('establishes the cookie for an existing verified tab and keeps restore guarded', () => {
    const { controller, request, response } = fixture();
    expect(controller.me(user, request, response)).toEqual(user);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('HttpOnly')
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, V2AuthController.prototype.session)).not.toBe(true);
    expect(
      Reflect.getMetadata(ALLOW_DURING_PASSWORD_RESET_KEY, V2AuthController.prototype.session)
    ).toBe(true);
    expect(controller.session(user, request)).toEqual({ accessToken: 'test-token', user });
  });

  it('expires the browser cookie even when remote revocation fails', async () => {
    const { controller, service, request, response } = fixture();
    service.logout.mockRejectedValueOnce(new Error('unavailable'));
    await expect(controller.logout(request, response, user)).rejects.toThrow('unavailable');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Max-Age=0')
    );
  });

  it('expires the browser cookie only after a successful password change', async () => {
    const { controller, request, response } = fixture();
    await controller.changePassword(
      { currentPassword: 'old-test-password', newPassword: 'new-test-password' },
      request,
      user,
      response
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Max-Age=0')
    );
  });

  it.each(['%broken', ''])('rejects malformed cookie values %s', (value) => {
    const { request } = fixture();
    expect(
      readBrowserSessionToken({
        ...request,
        headers: { ...request.headers, cookie: `${BROWSER_SESSION_COOKIE_NAME}=${value}` }
      })
    ).toBeUndefined();
  });

  it('rejects ambiguous duplicate cookies', () => {
    const { request } = fixture();
    expect(
      readBrowserSessionToken({
        ...request,
        headers: {
          ...request.headers,
          cookie: `${BROWSER_SESSION_COOKIE_NAME}=one; ${BROWSER_SESSION_COOKIE_NAME}=two`
        }
      })
    ).toBeUndefined();
  });
});
