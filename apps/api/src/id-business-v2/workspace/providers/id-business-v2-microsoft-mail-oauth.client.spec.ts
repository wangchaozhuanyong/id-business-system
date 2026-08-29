import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdBusinessV2MicrosoftMailOAuthClient,
  MicrosoftMailOAuthAuthenticationError
} from './id-business-v2-microsoft-mail-oauth.client';

function client() {
  const values: Record<string, string> = {
    MICROSOFT_MAIL_OAUTH_CLIENT_ID: 'client-id',
    MICROSOFT_MAIL_OAUTH_CLIENT_SECRET: 'client-secret',
    MICROSOFT_MAIL_OAUTH_REDIRECT_URI:
      'https://admin.company.io/api/public/mailbox/microsoft-oauth/callback'
  };
  return new IdBusinessV2MicrosoftMailOAuthClient({
    get: (key: string) => values[key]
  } as ConfigService);
}

describe('IdBusinessV2MicrosoftMailOAuthClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a state-bound Microsoft authorization URL with IMAP scope', () => {
    const url = new URL(client().createAuthorizationUrl('oauth-state', 'buyer@outlook.com'));
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('state')).toBe('oauth-state');
    expect(url.searchParams.get('login_hint')).toBe('buyer@outlook.com');
    expect(url.searchParams.get('scope')).toContain('IMAP.AccessAsUser.All');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges an authorization code for access and refresh tokens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().exchangeAuthorizationCode('authorization-code')).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toContain('grant_type=authorization_code');
    expect(String(request.body)).toContain('client_secret=client-secret');
  });

  it('classifies an invalid refresh grant as an expired authorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    await expect(client().refreshAccessToken('expired-refresh-token')).rejects.toBeInstanceOf(
      MicrosoftMailOAuthAuthenticationError
    );
  });
});
