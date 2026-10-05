import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2VendureMailboxClient } from './id-business-v2-vendure-mailbox.client';

describe('IdBusinessV2VendureMailboxClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['admin', 'shop'])(
    'normalizes %s mail codes without trusting stale words or changing the original mail',
    async (entry) => {
      const base = {
        subject: 'Your temporary ChatGPT verification code',
        fromAddress: 'noreply@openai.com',
        receivedAt: '2026-10-04T01:00:00.000Z',
        targetEmail: 'synthetic@example.test'
      };
      const mails = [
        { ...base, id: 'recover', extractedCode: 'ChatGPT', bodyText: 'ChatGPT\n012345\nContinue' },
        { ...base, id: 'unrecognized', extractedCode: 'continue', bodyText: 'ChatGPT\nContinue' },
        { ...base, id: 'ambiguous', extractedCode: 'ChatGPT', bodyText: '123456\n654321' },
        { ...base, id: 'other', subject: 'Other service', extractedCode: 'AB12CD', bodyText: null },
        ...['1234-5678', '123456@example.test', '1234 5678', '1234 - 5678'].map((token, index) => ({
          ...base,
          id: `invalid-complete-token-${index}`,
          subject: 'Other provider',
          extractedCode: 'continue',
          bodyText: `Security code: ${token}`
        })),
        ...['123456\n789', 'Security code:1234\n567890', 'Security code:012345'].map(
          (bodyText, index) => ({
            ...base,
            id: `chatgpt-line-integrity-${index}`,
            extractedCode: 'ChatGPT',
            bodyText
          })
        )
      ];
      const queryResult = { success: true, totalEmails: mails.length, items: mails };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json({
            data:
              entry === 'admin' ? { icloudReceivedMails: mails } : { icloudQueryMails: queryResult }
          })
        )
      );
      const client = new IdBusinessV2VendureMailboxClient(
        new ConfigService({
          VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
          VENDURE_MAILBOX_SHOP_API_URL: 'https://vendure.example/shop-api',
          VENDURE_MAILBOX_API_KEY: 'synthetic-key'
        })
      );
      const result =
        entry === 'admin'
          ? await client.receivedMails({ virtualEmailId: 'synthetic-alias' })
          : (await client.publicQuery('BUY-SYNTHETIC')).items;
      expect(result.map((mail) => mail.extractedCode)).toEqual([
        '012345',
        null,
        null,
        'AB12CD',
        null,
        null,
        null,
        null,
        null,
        null,
        '012345'
      ]);
      expect(result.map((mail) => mail.id)).toEqual(mails.map((mail) => mail.id));
      expect(result[0]?.bodyText).toBe(mails[0]?.bodyText);
      expect(mails[0]?.extractedCode).toBe('ChatGPT');
    }
  );

  it('keeps the dedicated API key server-side on admin GraphQL requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { icloudPrimaryAccounts: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    expect(client.isConfigured()).toBe(true);
    await expect(client.primaryAccounts()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vendure.example/admin-api');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'vendure-api-key': 'dedicated-mailbox-key' })
    });
  });

  it('authenticates the Shop API and forwards the trusted client IP in dedicated headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          icloudQueryMails: {
            success: true,
            message: null,
            targetType: 'virtual',
            aliasEmail: 'buyer@example.com',
            primaryEmail: null,
            codeExpiresAt: null,
            remainingDays: null,
            totalEmails: 0,
            items: [],
            virtualEmailsList: null
          }
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_SHOP_API_URL: 'https://vendure.example/shop-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    await client.publicQuery('BUY-TEST-CODE', '203.0.113.25');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-id-business-client-ip']).toBe('203.0.113.25');
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['vendure-api-key']).toBe('dedicated-mailbox-key');
  });

  it('imports aliases using the upstream batch contract and preserves partial results', async () => {
    const input = {
      primaryAccountId: '1',
      rawInput: 'new@example.com\nexisting@example.com\ninvalid',
      codeResetIntervalDays: 30
    };
    const result = { createdCount: 1, skippedCount: 1, errors: ['第 3 行：邮箱格式无效'] };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: { input: typeof input };
      };
      // Vendure rejects unknown input types before executing the batch resolver.
      const inputType = body.query.match(/\$input:\s*(\w+)!/)?.[1];
      if (inputType !== 'BatchCreateIcloudVirtualEmailsInput') {
        return Response.json(
          { errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
          { status: 400 }
        );
      }
      expect(body.variables).toEqual({ input });
      return Response.json({ data: { result } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    await expect(client.batchCreateAliases(input)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns a sanitized service error when Vendure exposes GraphQL details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ errors: [{ message: 'secret upstream detail' }] }))
    );
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    const error = await client.primaryAccounts().catch((value) => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error.message)).not.toContain('secret upstream detail');
  });

  it('reports an actionable authorization error without exposing GraphQL details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          errors: [{ message: 'private permission detail', extensions: { code: 'FORBIDDEN' } }]
        })
      )
    );
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    const error = await client.checkConnection().catch((value) => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error.message)).toContain('授权无效或权限不足');
    expect(String(error.message)).not.toContain('private permission detail');
  });
});
