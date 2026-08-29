import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_MAIL_SCOPES = [
  'offline_access',
  'openid',
  'email',
  'https://outlook.office.com/IMAP.AccessAsUser.All'
] as const;
const TOKEN_REQUEST_TIMEOUT_MS = 12_000;

export class MicrosoftMailOAuthConfigurationError extends Error {
  constructor() {
    super('Microsoft 邮箱授权尚未配置');
    this.name = 'MicrosoftMailOAuthConfigurationError';
  }
}

export class MicrosoftMailOAuthAuthenticationError extends Error {
  constructor() {
    super('Microsoft 邮箱授权已失效');
    this.name = 'MicrosoftMailOAuthAuthenticationError';
  }
}

export class MicrosoftMailOAuthUnavailableError extends Error {
  constructor() {
    super('Microsoft 授权服务暂时不可用');
    this.name = 'MicrosoftMailOAuthUnavailableError';
  }
}

export interface MicrosoftMailOAuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class IdBusinessV2MicrosoftMailOAuthClient {
  constructor(private readonly configService: ConfigService) {}

  createAuthorizationUrl(state: string, email: string) {
    const config = this.getConfig();
    const url = new URL(MICROSOFT_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', MICROSOFT_MAIL_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('login_hint', email);
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  exchangeAuthorizationCode(code: string) {
    const config = this.getConfig();
    return this.requestToken(
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
        scope: MICROSOFT_MAIL_SCOPES.join(' ')
      })
    );
  }

  refreshAccessToken(refreshToken: string) {
    const config = this.getConfig();
    return this.requestToken(
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        redirect_uri: config.redirectUri,
        scope: MICROSOFT_MAIL_SCOPES.join(' ')
      }),
      refreshToken
    );
  }

  private async requestToken(body: URLSearchParams, fallbackRefreshToken = '') {
    let response: Response;
    try {
      response = await fetch(MICROSOFT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new MicrosoftMailOAuthUnavailableError();
    }

    const payload = await this.readJson(response);
    if (!response.ok) {
      const errorCode = typeof payload.error === 'string' ? payload.error : '';
      if (
        errorCode === 'invalid_grant' ||
        errorCode === 'interaction_required' ||
        errorCode === 'consent_required'
      ) {
        throw new MicrosoftMailOAuthAuthenticationError();
      }
      throw new MicrosoftMailOAuthUnavailableError();
    }

    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    const refreshToken =
      typeof payload.refresh_token === 'string' ? payload.refresh_token : fallbackRefreshToken;
    if (!accessToken || !refreshToken) throw new MicrosoftMailOAuthAuthenticationError();
    return { accessToken, refreshToken } satisfies MicrosoftMailOAuthTokens;
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const payload: unknown = await response.json();
      return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private getConfig() {
    const clientId = this.configService.get<string>('MICROSOFT_MAIL_OAUTH_CLIENT_ID')?.trim();
    const clientSecret = this.configService
      .get<string>('MICROSOFT_MAIL_OAUTH_CLIENT_SECRET')
      ?.trim();
    const redirectUri = this.configService.get<string>('MICROSOFT_MAIL_OAUTH_REDIRECT_URI')?.trim();
    if (!clientId || !clientSecret || !redirectUri) {
      throw new MicrosoftMailOAuthConfigurationError();
    }
    return { clientId, clientSecret, redirectUri };
  }
}
