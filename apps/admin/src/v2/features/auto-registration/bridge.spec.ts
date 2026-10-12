import { describe, expect, it } from 'vitest';
import {
  readRegistrationChildMessage,
  registrationThemeState,
  registrationWorkspaceUrl,
  sanitizeRegistrationDraft,
  sanitizeAppleMailboxRequest
} from './bridge';
import { AUTO_REGISTRATION_WORKSPACE_PATH } from './contracts';

describe('automatic registration workspace bridge', () => {
  it('only opens the fixed same-origin workspace and known page paths', () => {
    expect(registrationWorkspaceUrl(AUTO_REGISTRATION_WORKSPACE_PATH, '/')).toBe(
      AUTO_REGISTRATION_WORKSPACE_PATH
    );
    expect(registrationWorkspaceUrl(AUTO_REGISTRATION_WORKSPACE_PATH, '/accounts')).toBe(
      `${AUTO_REGISTRATION_WORKSPACE_PATH}accounts`
    );
    expect(() => registrationWorkspaceUrl('https://another.invalid/', '/')).toThrow();
    expect(() => registrationWorkspaceUrl('//another.invalid/', '/')).toThrow();
  });

  it('rejects draft messages from another origin, another frame, or another page', () => {
    const frame = {} as Window;
    const event = {
      origin: 'http://localhost:5173',
      source: frame,
      data: { type: 'id-registration:draft', page: '/accounts', values: { search: '账号' } }
    };
    expect(readRegistrationChildMessage(event, frame, event.origin, '/accounts')).toEqual(
      event.data
    );
    expect(
      readRegistrationChildMessage(event, {} as Window, event.origin, '/accounts')
    ).toBeUndefined();
    expect(
      readRegistrationChildMessage(event, frame, 'https://another.invalid', '/accounts')
    ).toBeUndefined();
    expect(readRegistrationChildMessage(event, frame, event.origin, '/')).toBeUndefined();
    expect(
      readRegistrationChildMessage({ ...event, data: null }, frame, event.origin, '/')
    ).toBeUndefined();
  });

  it('accepts a known ready page after internal navigation but rejects unknown paths', () => {
    const frame = {} as Window;
    const event = {
      origin: 'http://localhost:5374',
      source: frame,
      data: { type: 'id-registration:ready', page: '/accounts' }
    };
    expect(readRegistrationChildMessage(event, frame, event.origin, '/')).toEqual(event.data);
    expect(readRegistrationChildMessage(event, {} as Window, event.origin, '/')).toBeUndefined();
    expect(
      readRegistrationChildMessage(event, frame, 'https://another.invalid', '/')
    ).toBeUndefined();
    expect(
      readRegistrationChildMessage(
        { ...event, data: { type: 'id-registration:ready', page: '/unknown' } },
        frame,
        event.origin,
        '/'
      )
    ).toBeUndefined();
    expect(
      readRegistrationChildMessage(
        { ...event, data: { type: 'id-registration:ready', page: '/accounts/../settings' } },
        frame,
        event.origin,
        '/'
      )
    ).toBeUndefined();
  });

  it('keeps ordinary input but excludes credentials and one-use authorization fields', () => {
    expect(
      sanitizeRegistrationDraft({
        search: '账号',
        page: '2',
        enabled: true,
        password: 'excluded',
        accessToken: 'excluded',
        api_key: 'excluded',
        'tm-service-key': 'excluded',
        proxyUrl: 'excluded',
        otp: 'excluded',
        cvv: 'excluded',
        importText: 'excluded',
        'link-text': 'excluded',
        'custom-api-url': 'https://user:excluded@example.invalid',
        nested: { password: 'excluded' }
      })
    ).toEqual({ search: '账号', page: '2', enabled: true });
    expect(sanitizeRegistrationDraft('invalid')).toEqual({});
    expect(sanitizeRegistrationDraft({ search: 'x'.repeat(4001) })).toEqual({});
  });

  it('only sends selected shared theme tokens and sanitized draft values', () => {
    const state = registrationThemeState(
      { dataset: { v2Theme: 'dark' } },
      { getPropertyValue: (key) => `value:${key}` },
      { search: '筛选', password: 'excluded' }
    );
    expect(state.theme).toBe('dark');
    expect(state.type).toBe('id-registration:state');
    expect(state.tokens['--v2-bg']).toBe('value:--v2-bg');
    expect(state.draft).toEqual({ search: '筛选' });
    expect(state).not.toHaveProperty('token');
  });

  it('只接受同一控制台的受控隐藏邮箱命令，不透传秘密或自定接口', () => {
    const frame = {} as Window;
    const event = {
      source: frame,
      origin: 'http://localhost:5173',
      data: {
        type: 'id-registration:apple-request',
        page: '/',
        requestId: 'request-1',
        action: 'start',
        payload: {
          aliasId: 'alias-1',
          revision: 0,
          proxyId: 'route-1',
          auto_upload_cpa: true,
          cpa_service_ids: [8]
        }
      }
    };
    expect(readRegistrationChildMessage(event, frame, event.origin, '/')).toEqual(event.data);
    expect(readRegistrationChildMessage(event, frame, event.origin, '/accounts')).toBeUndefined();
    expect(readRegistrationChildMessage(event, {} as Window, event.origin, '/')).toBeUndefined();
    expect(
      readRegistrationChildMessage(
        { ...event, data: { ...event.data, action: 'delete' } },
        frame,
        event.origin,
        '/'
      )
    ).toBeUndefined();
    expect(
      sanitizeAppleMailboxRequest('start', { proxyUrl: 'https://example.invalid' })
    ).toBeUndefined();
    expect(sanitizeAppleMailboxRequest('start', { password: 'excluded' })).toBeUndefined();
    expect(sanitizeAppleMailboxRequest('task', { taskUuid: '../another' })).toBeUndefined();
  });

  it('系统代理编号与服务端保持191字符上限，其余资料标识保留原限制', () => {
    const proxyId = 'p'.repeat(191);
    expect(sanitizeAppleMailboxRequest('start', { proxyId })).toEqual({ proxyId });
    const batch = {
      count: 1,
      concurrency: 1,
      mode: 'pipeline',
      interval_min: 0,
      interval_max: 0,
      proxyId
    };
    expect(sanitizeAppleMailboxRequest('batch', batch)).toEqual(batch);
    expect(sanitizeAppleMailboxRequest('start', { proxyId: 'p'.repeat(192) })).toBeUndefined();
    expect(sanitizeAppleMailboxRequest('start', { proxyId: 'route:1' })).toBeUndefined();
    expect(
      sanitizeAppleMailboxRequest('start', { aliasId: 'a'.repeat(129), revision: 0 })
    ).toBeUndefined();
  });

  it('自动单个不要求指定邮箱，批量参数保留零间隔并拒绝重复绑定', () => {
    expect(sanitizeAppleMailboxRequest('start', {})).toEqual({});
    expect(sanitizeAppleMailboxRequest('start', { aliasId: 'alias-1' })).toBeUndefined();
    const batch = {
      count: 2,
      concurrency: 2,
      mode: 'parallel',
      interval_min: 0,
      interval_max: 0,
      targets: [
        { aliasId: 'alias-1', revision: 2 },
        { aliasId: 'alias-2', revision: 4 }
      ],
      auto_upload_tm: true,
      tm_service_ids: [3, 4]
    };
    expect(sanitizeAppleMailboxRequest('batch', batch)).toEqual(batch);
    expect(
      sanitizeAppleMailboxRequest('batch', {
        ...batch,
        targets: [batch.targets[0], batch.targets[0]]
      })
    ).toBeUndefined();
    expect(sanitizeAppleMailboxRequest('batch', { ...batch, count: 0 })).toBeUndefined();
    expect(
      sanitizeAppleMailboxRequest('batch', { ...batch, interval_min: 5, interval_max: 4 })
    ).toBeUndefined();
    expect(
      sanitizeAppleMailboxRequest('batch', { ...batch, cpa_service_ids: ['1'] })
    ).toBeUndefined();
  });
});
