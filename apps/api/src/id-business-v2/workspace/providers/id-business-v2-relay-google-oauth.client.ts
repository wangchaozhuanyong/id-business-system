import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { idBusinessV2RelayFetchJson } from './id-business-v2-relay-http';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'];

export interface IdBusinessV2GoogleOAuthToken {
  access_token: string;
  expires_at: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

@Injectable()
export class IdBusinessV2RelayGoogleOAuthClient {
  createCodeChallenge(verifier: string) {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  createAuthorizationUrl(input: {
    callbackUrl: string;
    challenge: string;
    clientId: string;
    state: string;
  }) {
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      access_type: 'offline',
      client_id: input.clientId,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
      include_granted_scopes: 'true',
      prompt: 'consent select_account',
      redirect_uri: input.callbackUrl,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      state: input.state
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    callbackUrl: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    verifier: string;
  }): Promise<IdBusinessV2GoogleOAuthToken> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: 'authorization_code',
      redirect_uri: input.callbackUrl
    });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const token = await idBusinessV2RelayFetchJson<Record<string, unknown>>(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    return this.normalizeToken(token);
  }

  async refresh(input: {
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  }): Promise<IdBusinessV2GoogleOAuthToken> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken
    });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const token = await idBusinessV2RelayFetchJson<Record<string, unknown>>(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    return this.normalizeToken({
      ...token,
      refresh_token: token.refresh_token ?? input.refreshToken,
      scope: token.scope ?? input.scope
    });
  }

  async getEmail(accessToken: string) {
    const profile = await idBusinessV2RelayFetchJson<Record<string, unknown>>(
      GOOGLE_USERINFO_ENDPOINT,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    return typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : null;
  }

  private normalizeToken(token: Record<string, unknown>): IdBusinessV2GoogleOAuthToken {
    if (typeof token.access_token !== 'string' || token.access_token.length < 10) {
      throw new Error('Google 授权没有返回访问令牌');
    }
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [];
    if (!scopes.includes('https://www.googleapis.com/auth/cloud-platform')) {
      throw new Error('Google 授权缺少 Cloud 管理权限');
    }
    return {
      access_token: token.access_token,
      expires_at: Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000,
      ...(typeof token.refresh_token === 'string' ? { refresh_token: token.refresh_token } : {}),
      ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
      ...(typeof token.token_type === 'string' ? { token_type: token.token_type } : {})
    };
  }
}
