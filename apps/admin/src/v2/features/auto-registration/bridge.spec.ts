import { describe, expect, it } from 'vitest';
import {
  readRegistrationChildMessage,
  registrationThemeState,
  registrationWorkspaceUrl,
  sanitizeRegistrationDraft
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
});
