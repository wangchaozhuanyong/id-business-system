import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE,
  IdBusinessV2GoogleSheetsOAuthClient
} from './id-business-v2-google-sheets-oauth.client';

describe('IdBusinessV2GoogleSheetsOAuthClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests offline access with only the per-file Drive scope', () => {
    const client = new IdBusinessV2GoogleSheetsOAuthClient();
    const url = new URL(
      client.createAuthorizationUrl({
        callbackUrl: 'https://admin.example.com/api/public/google-sheets-sync/oauth/callback',
        challenge: 'challenge',
        clientId: 'client.apps.googleusercontent.com',
        state: 'state'
      })
    );

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toContain('consent');
    expect(url.searchParams.get('scope')).toBe(ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE);
    expect(url.searchParams.get('scope')).not.toContain('/auth/drive ');
    expect(url.searchParams.get('scope')).not.toContain('/auth/spreadsheets');
  });

  it('requires the exact drive.file grant when exchanging an authorization code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'access-token-value',
            expires_in: 3600,
            refresh_token: 'refresh-token-value',
            scope: ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const client = new IdBusinessV2GoogleSheetsOAuthClient();
    const token = await client.exchangeCode({
      callbackUrl: 'https://admin.example.com/api/public/google-sheets-sync/oauth/callback',
      clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'secret',
      code: 'authorization-code',
      verifier: 'verifier'
    });

    expect(token.refreshToken).toBe('refresh-token-value');
    expect(token.scope).toBe(ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE);
  });
});
