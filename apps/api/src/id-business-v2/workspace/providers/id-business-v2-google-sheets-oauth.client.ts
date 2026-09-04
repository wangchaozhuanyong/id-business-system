import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { idBusinessV2GoogleApiFetchJson } from './id-business-v2-google-api-http';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/drive.file';

interface GoogleTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

export interface IdBusinessV2GoogleSheetsToken {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scope: string;
}

@Injectable()
export class IdBusinessV2GoogleSheetsOAuthClient {
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
      scope: ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE,
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
  }) {
    const body = new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: 'authorization_code',
      redirect_uri: input.callbackUrl
    });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const token = await idBusinessV2GoogleApiFetchJson<GoogleTokenResponse>(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    return this.normalizeToken(token);
  }

  async refresh(input: { clientId: string; clientSecret?: string; refreshToken: string }) {
    const body = new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken
    });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const token = await idBusinessV2GoogleApiFetchJson<GoogleTokenResponse>(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    return this.normalizeToken({
      ...token,
      scope: token.scope ?? ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE
    });
  }

  private normalizeToken(token: GoogleTokenResponse): IdBusinessV2GoogleSheetsToken {
    if (typeof token.access_token !== 'string' || token.access_token.length < 10) {
      throw new Error('Google 授权没有返回访问令牌');
    }
    const scope = typeof token.scope === 'string' ? token.scope : '';
    if (!scope.split(/\s+/).includes(ID_BUSINESS_V2_GOOGLE_SHEETS_SCOPE)) {
      throw new Error('Google 授权缺少报表文件权限');
    }
    return {
      accessToken: token.access_token,
      expiresIn: Math.max(60, Number(token.expires_in ?? 3600)),
      refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
      scope
    };
  }
}
