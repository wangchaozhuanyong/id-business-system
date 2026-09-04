import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_API_RESPONSE_KEY } from '../../common/interceptors/skip-api-response.decorator';
import { IdBusinessV2RelayScriptOAuthController } from './id-business-v2-relay-script-oauth.controller';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGoogleOAuthClient } from './providers/id-business-v2-relay-google-oauth.client';
import { idBusinessV2RelayFetchJson } from './providers/id-business-v2-relay-http';
import {
  idBusinessV2RelayJobSteps,
  toIdBusinessV2RelayJob
} from './id-business-v2-relay-script.support';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('online relay script safety contract', () => {
  it('returns the public Google OAuth callback as HTML without JSON wrapping', () => {
    expect(
      Reflect.getMetadata(
        SKIP_API_RESPONSE_KEY,
        IdBusinessV2RelayScriptOAuthController.prototype.callback
      )
    ).toBe(true);
  });

  it('builds a Google Cloud PKCE authorization URL for the configured public callback', () => {
    const client = new IdBusinessV2RelayGoogleOAuthClient();
    const verifier = 'v'.repeat(64);
    const callbackUrl = 'https://id.example.com/api/public/workspace-relay/google-oauth/callback';
    const authorizationUrl = new URL(
      client.createAuthorizationUrl({
        callbackUrl,
        challenge: client.createCodeChallenge(verifier),
        clientId: '123.apps.googleusercontent.com',
        state: 'state-value'
      })
    );

    expect(authorizationUrl.origin).toBe('https://accounts.google.com');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/cloud-platform'
    );
    expect(authorizationUrl.searchParams.get('state')).toBe('state-value');
  });

  it('redacts token-like remote error content before exposing a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ message: `Bearer ${'sensitive-token-value-'.repeat(3)}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );

    await expect(idBusinessV2RelayFetchJson('https://example.com')).rejects.toMatchObject({
      code: 'REMOTE_HTTP_ERROR',
      message: '[已隐藏]'
    });
  });

  it('uses the dedicated scheduling endpoint around Vertex account validation', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ body, method, pathname: url.pathname });
        const data =
          method === 'GET' && url.pathname === '/api/v1/admin/accounts/91'
            ? { id: 91, schedulable: true, groups: [{ id: 12 }] }
            : method === 'POST' && url.pathname === '/api/v1/admin/accounts'
              ? { id: 91, platform: 'gemini', type: 'service_account' }
              : url.pathname.endsWith('/admin/accounts')
                ? { items: [] }
                : {};
        return new Response(JSON.stringify({ code: 0, data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    const client = new IdBusinessV2RelayCloudBridgeClient();

    await client.createVertexAccount({
      accessToken: 'cloudbridge-access-token',
      accountLabel: '客户 A',
      clientEmail: 'cloudbridge-vertex@vertex-customer-a.iam.gserviceaccount.com',
      creditExpiresAt: null,
      location: 'global',
      modelMapping: { 'gemini-test': 'gemini-test' },
      projectId: 'vertex-customer-a',
      proxyId: null,
      serviceAccountJson: { project_id: 'vertex-customer-a' }
    });
    await client.attachGroup(91, 12, 'cloudbridge-access-token');

    const accountCreate = requests.find(
      (request) => request.method === 'POST' && request.pathname === '/api/v1/admin/accounts'
    );
    expect(accountCreate?.body).not.toHaveProperty('schedulable');
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: { schedulable: false },
          method: 'POST',
          pathname: '/api/v1/admin/accounts/91/schedulable'
        }),
        expect.objectContaining({
          body: { group_ids: [12], priority: 99, status: 'active' },
          method: 'PUT',
          pathname: '/api/v1/admin/accounts/91'
        }),
        expect.objectContaining({
          body: { schedulable: true },
          method: 'POST',
          pathname: '/api/v1/admin/accounts/91/schedulable'
        })
      ])
    );
  });

  it('returns only public job progress and advances to the first incomplete step', () => {
    const result = toIdBusinessV2RelayJob({
      accountLabel: '客户 A',
      billingAccount: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC',
      cloudBridgeAccountId: null,
      completedSteps: ['create_project'],
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
      creditExpiresAt: null,
      deploymentKey: 'vertex-customer-a',
      googleEmail: null,
      id: 'e400eb2b-6d10-4d9b-85a9-28310bc7ebea',
      lastErrorCode: null,
      lastErrorMessage: null,
      location: 'global',
      mode: 'vertex',
      modeSecretEncrypted: null,
      modelMapping: { 'gemini-test': 'gemini-test' },
      progress: { projectNumber: '123' },
      projectDisplayName: '客户 A Vertex',
      projectId: 'vertex-customer-a',
      proxyId: null,
      referenceAccountId: 1,
      runLeaseExpiresAt: null,
      runLeaseId: null,
      serviceAccountKeyEncrypted: 'must-not-be-returned',
      settings: {},
      status: 'running',
      targetGroupId: 2,
      updatedAt: new Date('2026-09-03T00:00:01.000Z'),
      userId: '23e143ef-a691-4b74-a48f-00c4daf7dfd6'
    });

    expect(result.currentStep).toBe('link_billing');
    expect(result).not.toHaveProperty('serviceAccountKeyEncrypted');
    expect(result).not.toHaveProperty('modelMapping');
    expect(result).not.toHaveProperty('progress');
    expect(result).not.toHaveProperty('modeSecretEncrypted');
    expect(result.totalSteps).toBe(9);
  });

  it('keeps distinct resumable steps for all three deployment modes', () => {
    expect(idBusinessV2RelayJobSteps('antigravity_subscription')).toEqual([
      'authorize_account',
      'set_privacy',
      'sync_models',
      'configure_models',
      'test_models',
      'attach_group'
    ]);
    expect(idBusinessV2RelayJobSteps('gemini_api')).toEqual([
      'verify_provider_models',
      'test_provider_text',
      'test_provider_tts',
      'create_cloudbridge_account',
      'test_models',
      'attach_group'
    ]);
    expect(idBusinessV2RelayJobSteps('vertex')).toHaveLength(9);
  });

  it('creates an unschedulable AI Studio account with the fixed text and TTS models', async () => {
    const requests: Array<{ body: Record<string, unknown>; pathname: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        requests.push({
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
          pathname: url.pathname
        });
        return new Response(JSON.stringify({ code: 0, data: { id: 92 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    const client = new IdBusinessV2RelayCloudBridgeClient();
    await client.createGeminiApiKeyAccount({
      accessToken: 'cloudbridge-access-token',
      accountLabel: '客户 B',
      apiKey: 'gemini-api-key-value',
      deploymentKey: 'gemini-api-customer-b',
      modelMapping: {
        'gemini-3.1-flash-tts-preview': 'gemini-3.1-flash-tts-preview',
        'gemini-3.7-flash': 'gemini-3.7-flash'
      },
      proxyId: null
    });
    const credentials = requests[0]?.body.credentials as Record<string, unknown>;
    expect(requests[0]?.body).toMatchObject({
      platform: 'gemini',
      schedulable: false,
      type: 'apikey'
    });
    expect(credentials.model_mapping).toEqual({
      'gemini-3.1-flash-tts-preview': 'gemini-3.1-flash-tts-preview',
      'gemini-3.7-flash': 'gemini-3.7-flash'
    });
  });
});
