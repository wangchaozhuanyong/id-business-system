import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign } from 'node:crypto';
import { V2_FLASHCAST_ANALYTICS, type V2WebsiteAnalyticsDays } from '@apple-business/shared';
import {
  IdBusinessV2GoogleApiError,
  idBusinessV2GoogleApiFetchJson
} from './id-business-v2-google-api-http';

export interface WebsiteAnalyticsRawReport {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
  metadata?: { timeZone?: string; subjectToThresholding?: boolean; dataLossFromOtherRow?: boolean };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const METRICS = ['screenPageViews', 'totalUsers', 'sessions'];

@Injectable()
export class IdBusinessV2WebsiteAnalyticsClient {
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured() {
    return Boolean(this.config.get<string>('WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON')?.trim());
  }

  async reports(days: V2WebsiteAnalyticsDays) {
    const accessToken = await this.accessToken();
    try {
      return await idBusinessV2GoogleApiFetchJson<{ reports?: WebsiteAnalyticsRawReport[] }>(
        'https://analyticsdata.googleapis.com/v1beta/properties/' +
          V2_FLASHCAST_ANALYTICS.propertyId +
          ':batchRunReports',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + accessToken },
          timeoutMs: 15_000,
          body: JSON.stringify({
            requests: [false, true].map((daily) => ({
              dateRanges: [{ startDate: String(days - 1) + 'daysAgo', endDate: 'today' }],
              dimensions: daily ? [{ name: 'date' }] : [],
              metrics: METRICS.map((name) => ({ name })),
              dimensionFilter: {
                andGroup: {
                  expressions: [
                    {
                      filter: {
                        fieldName: 'hostName',
                        inListFilter: {
                          values: ['flashcast.com.my', 'www.flashcast.com.my'],
                          caseSensitive: false
                        }
                      }
                    },
                    {
                      filter: {
                        fieldName: 'streamId',
                        stringFilter: {
                          matchType: 'EXACT',
                          value: V2_FLASHCAST_ANALYTICS.streamId
                        }
                      }
                    }
                  ]
                }
              },
              ...(daily ? { orderBys: [{ dimension: { dimensionName: 'date' } }] } : {}),
              limit: '31'
            }))
          })
        }
      );
    } catch (error) {
      if (error instanceof IdBusinessV2GoogleApiError && error.status === 401) this.token = null;
      throw error;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.createAccessToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  private async createAccessToken() {
    // This credential is dedicated to read-only website reports. Never reuse Sheets/relay tokens.
    try {
      const credential: unknown = JSON.parse(
        this.config.get<string>('WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON') || '{}'
      );
      if (!credential || typeof credential !== 'object') throw new Error();
      const record = credential as Record<string, unknown>;
      if (
        record.type !== 'service_account' ||
        typeof record.client_email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(record.client_email) ||
        typeof record.private_key !== 'string'
      )
        throw new Error();
      const privateKey = createPrivateKey(record.private_key);
      if (privateKey.asymmetricKeyType !== 'rsa') throw new Error();
      const now = Math.floor(Date.now() / 1000);
      const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload =
        encoded({ alg: 'RS256', typ: 'JWT' }) +
        '.' +
        encoded({
          iss: record.client_email,
          scope: READ_ONLY_SCOPE,
          aud: TOKEN_URL,
          iat: now,
          exp: now + 3600
        });
      const assertion =
        payload + '.' + sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url');
      const response = await idBusinessV2GoogleApiFetchJson<{
        access_token?: unknown;
        expires_in?: unknown;
      }>(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeoutMs: 10_000,
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion
        }).toString()
      });
      if (
        typeof response.access_token !== 'string' ||
        !response.access_token ||
        typeof response.expires_in !== 'number' ||
        !Number.isFinite(response.expires_in) ||
        response.expires_in <= 0
      )
        throw new Error();
      this.token = {
        value: response.access_token,
        expiresAt: Date.now() + Math.min(response.expires_in, 3600) * 1000
      };
      return this.token.value;
    } catch {
      throw new ServiceUnavailableException('访问统计授权不可用，请管理员检查专用只读授权配置');
    }
  }
}
