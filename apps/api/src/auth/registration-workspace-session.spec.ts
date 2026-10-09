import { ApiHttpException } from '../common/errors/api-http.exception';
import {
  clearRegistrationWorkspaceSession,
  createRegistrationWorkspaceSession,
  REGISTRATION_WORKSPACE_COOKIE_NAME,
  REGISTRATION_WORKSPACE_PATH,
  REGISTRATION_WORKSPACE_SESSION_TTL_MS,
  resolveRegistrationWorkspaceSession,
  type RegistrationWorkspaceRequest
} from './registration-workspace-session';

const NOW = Date.UTC(2026, 9, 9, 9);

function createFixture() {
  const response = { setHeader: jest.fn() };
  const request: RegistrationWorkspaceRequest = {
    method: 'POST',
    originalUrl: `${REGISTRATION_WORKSPACE_PATH}/api/tasks`,
    headers: { origin: 'http://localhost:5374', 'sec-fetch-site': 'same-origin' }
  };
  const result = createRegistrationWorkspaceSession(
    response,
    'fixture-access-token',
    'fixture-user-id',
    request,
    NOW
  );
  const cookie = String(response.setHeader.mock.calls[0]?.[1]);
  request.headers.cookie = cookie.split(';')[0];
  return { request, response, result, cookie };
}

afterEach(() => vi.unstubAllEnvs());

describe('registration workspace session', () => {
  it('issues a scoped opaque HttpOnly cookie and returns only expiry metadata', () => {
    const fixture = createFixture();
    expect(fixture.response.setHeader).toHaveBeenCalledWith('Set-Cookie', fixture.cookie);
    expect(fixture.cookie).toMatch(
      new RegExp(`^${REGISTRATION_WORKSPACE_COOKIE_NAME}=[\\w-]{43};`)
    );
    expect(fixture.cookie).toContain(
      `Path=${REGISTRATION_WORKSPACE_PATH}; HttpOnly; SameSite=Strict`
    );
    expect(fixture.cookie).toContain('Max-Age=1800');
    expect(fixture.cookie).not.toContain('fixture-access-token');
    expect(fixture.result).toEqual({
      expiresAt: new Date(NOW + REGISTRATION_WORKSPACE_SESSION_TTL_MS).toISOString()
    });
    expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toEqual({
      accessToken: 'fixture-access-token',
      userId: 'fixture-user-id'
    });
  });

  it('sets Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(createFixture().cookie).toContain('; Secure');
  });

  it.each(['cross-site', 'same-site', 'none', undefined])(
    'rejects bootstrap from %s fetch sites',
    (site) => {
      const response = { setHeader: jest.fn() };
      expect(() =>
        createRegistrationWorkspaceSession(response, 'fixture-token', 'fixture-user', {
          headers: { origin: 'http://localhost:5374', 'sec-fetch-site': site }
        })
      ).toThrow(ApiHttpException);
      expect(response.setHeader).not.toHaveBeenCalled();
    }
  );

  it.each([
    undefined,
    'null',
    'http://localhost:5374/',
    'https://name:password@example.test',
    'file:///tmp',
    ['http://localhost:5374', 'https://other.test']
  ])('rejects an absent or malformed bootstrap origin', (origin) => {
    const response = { setHeader: jest.fn() };
    expect(() =>
      createRegistrationWorkspaceSession(response, 'fixture-token', 'fixture-user', {
        headers: { origin, 'sec-fetch-site': 'same-origin' }
      })
    ).toThrow(ApiHttpException);
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it.each([
    '/api/id-business-v2/orders',
    `${REGISTRATION_WORKSPACE_PATH}-other`,
    `${REGISTRATION_WORKSPACE_PATH}/../orders`,
    `${REGISTRATION_WORKSPACE_PATH}/%2e%2e/orders`,
    `${REGISTRATION_WORKSPACE_PATH}%2fapi/tasks`,
    `${REGISTRATION_WORKSPACE_PATH}\\api/tasks`
  ])('does not authenticate a path outside the workspace boundary', (url) => {
    const fixture = createFixture();
    fixture.request.originalUrl = url;
    expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
  });

  it.each(['cross-site', 'same-site', 'none', undefined])(
    'rejects cookie access from %s fetch sites',
    (site) => {
      const fixture = createFixture();
      fixture.request.headers['sec-fetch-site'] = site;
      expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
    }
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'requires the frozen origin for %s',
    (method) => {
      const fixture = createFixture();
      fixture.request.method = method;
      delete fixture.request.headers.origin;
      expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
      fixture.request.headers.origin = 'http://localhost:3000';
      expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
      fixture.request.headers.origin = 'http://localhost:5374';
      expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeDefined();
    }
  );

  it.each(['GET', 'HEAD'])('allows same-origin %s without an Origin header', (method) => {
    const fixture = createFixture();
    fixture.request.method = method;
    fixture.request.originalUrl = `${REGISTRATION_WORKSPACE_PATH}?page=1`;
    delete fixture.request.headers.origin;
    expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeDefined();
    fixture.request.headers.origin = 'https://other.test';
    expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
  });

  it('rejects duplicate, malformed and unknown cookies', () => {
    const fixture = createFixture();
    const cookie = String(fixture.request.headers.cookie);
    for (const candidate of [
      `${cookie}; ${cookie}`,
      `${REGISTRATION_WORKSPACE_COOKIE_NAME}=%invalid`,
      `${REGISTRATION_WORKSPACE_COOKIE_NAME}=${'a'.repeat(43)}`
    ]) {
      fixture.request.headers.cookie = candidate;
      expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
    }
  });

  it('expires without extending its lifetime on access', () => {
    const fixture = createFixture();
    expect(
      resolveRegistrationWorkspaceSession(
        fixture.request,
        NOW + REGISTRATION_WORKSPACE_SESSION_TTL_MS - 1
      )
    ).toBeDefined();
    expect(
      resolveRegistrationWorkspaceSession(
        fixture.request,
        NOW + REGISTRATION_WORKSPACE_SESSION_TTL_MS
      )
    ).toBeUndefined();
  });

  it('clears the cookie and revokes the corresponding in-memory handle', () => {
    const fixture = createFixture();
    clearRegistrationWorkspaceSession(fixture.response, fixture.request);
    expect(resolveRegistrationWorkspaceSession(fixture.request, NOW)).toBeUndefined();
    expect(fixture.response.setHeader).toHaveBeenLastCalledWith(
      'Set-Cookie',
      expect.stringContaining(
        `${REGISTRATION_WORKSPACE_COOKIE_NAME}=; Path=${REGISTRATION_WORKSPACE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`
      )
    );
  });
});
