import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { V2ChangePublisherMessage } from '../../common/prisma/v2-change-event.publisher';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import { IdBusinessV2GoogleSheetsSyncWorker } from './id-business-v2-google-sheets-sync.worker';
import { IdBusinessV2GoogleApiError } from './providers/id-business-v2-google-api-http';
import {
  GOOGLE_SHEETS_RETENTION_KEY,
  writeGoogleSheetsRetention
} from './id-business-v2-google-sheets-retention';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function matches(record: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const filter = expected as { equals?: Date; gt?: Date };
      return (
        actual instanceof Date &&
        (!filter.equals || actual.getTime() === filter.equals.getTime()) &&
        (!filter.gt || actual.getTime() > filter.gt.getTime())
      );
    }
    return expected instanceof Date
      ? actual instanceof Date && actual.getTime() === expected.getTime()
      : actual === expected;
  });
}

function fixture() {
  const state: Record<string, unknown> = {
    id: 1,
    enabled: true,
    googleOAuthClientId: 'fixture.apps.googleusercontent.com',
    clientSecretEncrypted: 'encrypted-fixture-secret',
    refreshTokenEncrypted: 'encrypted-fixture-refresh',
    spreadsheetIdEncrypted: null,
    sourceVersions: {},
    oauthStateHash: 'hash:fixture-state-value-123456',
    oauthVerifierEncrypted: 'encrypted-fixture-verifier',
    oauthStateExpiresAt: new Date(Date.now() + 600_000)
  };
  const runMatches = (guard: {
    leaseId: string;
    clientId?: string;
    clientSecretEncrypted?: string;
    refreshTokenEncrypted?: string;
  }) =>
    matches(state, {
      enabled: true,
      runLeaseId: guard.leaseId,
      runLeaseExpiresAt: { gt: new Date() },
      ...(guard.clientId ? { googleOAuthClientId: guard.clientId } : {}),
      ...(guard.clientSecretEncrypted
        ? { clientSecretEncrypted: guard.clientSecretEncrypted }
        : {}),
      ...(guard.refreshTokenEncrypted ? { refreshTokenEncrypted: guard.refreshTokenEncrypted } : {})
    });
  const repository = {
    getConfiguration: vi.fn(async () => ({ ...state })),
    findConfigurationByStateHash: vi.fn(async (hash: string) =>
      state.oauthStateHash === hash ? { ...state } : null
    ),
    updateConfiguration: vi.fn(async (patch: Record<string, unknown>) =>
      Object.assign(state, patch)
    ),
    saveConfiguration: vi.fn(async (patch: Record<string, unknown>) => Object.assign(state, patch)),
    updateConfigurationIfCurrent: vi.fn(
      async (where: Record<string, unknown>, patch: Record<string, unknown>) => {
        if (!matches(state, where)) return false;
        Object.assign(state, patch);
        return true;
      }
    ),
    hasCurrentLease: vi.fn(async (guard: Parameters<typeof runMatches>[0]) => runMatches(guard)),
    updateRunIfCurrent: vi.fn(
      async (guard: Parameters<typeof runMatches>[0], patch: Record<string, unknown>) => {
        if (!runMatches(guard)) return false;
        Object.assign(state, patch);
        return true;
      }
    ),
    acquireLease: vi.fn(async (id: string, _now: Date, expiresAt: Date) => {
      if (!state.enabled || !state.refreshTokenEncrypted) return false;
      Object.assign(state, { runLeaseId: id, runLeaseExpiresAt: expiresAt });
      return true;
    }),
    releaseLease: vi.fn(async (id: string) => {
      if (state.runLeaseId === id)
        Object.assign(state, { runLeaseId: null, runLeaseExpiresAt: null });
    }),
    listSourceVersions: vi.fn(async (): Promise<Record<string, string>> => ({ orders: '1' })),
    loadReportSource: vi.fn(async () => ({
      orders: [],
      giftCards: [],
      renewals: [],
      financeJournals: [],
      chatgptAccounts: [],
      mailboxes: [],
      bankCards: [],
      customers: [],
      wallets: [],
      financeEntries: [],
      retention: { records: {} }
    }))
  };
  const encryption = {
    hash: (value: string) => `hash:${value}`,
    encrypt: (value: string) => `encrypted-${value}`,
    decrypt: (value: string) => value.replace(/^encrypted-/, '')
  };
  const transaction = { execute: async <T>(fn: (tx: never) => Promise<T>) => fn({} as never) };
  const audit = { append: vi.fn(async () => undefined) };
  const oauth = {
    refresh: vi.fn(async () => ({ accessToken: 'fixture-access' })),
    exchangeCode: vi.fn(async () => ({ refreshToken: 'fixture-new-refresh' }))
  };
  const sheets = {
    createSpreadsheet: vi.fn(async () => 'fixture-file'),
    ensureSpreadsheetInFolder: vi.fn(async () => undefined),
    ensureReportSheets: vi.fn(async () => undefined),
    replaceReports: vi.fn(async () => undefined),
    spreadsheetUrl: () => 'https://docs.google.com/spreadsheets/d/fixture/edit'
  };
  const config = {
    get: vi.fn<(key: string) => string | undefined>((key) =>
      key === 'APP_PUBLIC_URL' ? 'https://id.example.test' : undefined
    )
  };
  const changes = new Subject<V2ChangePublisherMessage>();
  const service = new IdBusinessV2GoogleSheetsSyncService(
    repository as never,
    transaction as never,
    audit as never,
    encryption as never,
    config as never,
    oauth as never,
    sheets as never
  );
  const worker = new IdBusinessV2GoogleSheetsSyncWorker(
    repository as never,
    service,
    encryption as never,
    oauth as never,
    sheets as never,
    transaction as never,
    audit as never,
    { events: () => changes.asObservable() } as never
  );
  return { state, repository, audit, oauth, sheets, service, worker, config, changes };
}

const operator = { id: 'fixture-admin', roles: ['admin'] } as never;
const callback = { state: 'fixture-state-value-123456', code: 'fixture-authorization-code' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Google Sheets authorization and sync cancellation', () => {
  function emitOrderChange(f: ReturnType<typeof fixture>) {
    f.changes.next({
      type: 'change',
      event: {
        schemaVersion: 1,
        eventId: 'fixture-event',
        occurredAt: new Date().toISOString(),
        scopes: [{ scope: 'orders', version: '2' }]
      }
    });
  }

  it('merges committed writes and runs without any browser subscriber', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(1);
      f.repository.listSourceVersions.mockResolvedValue({ orders: '2' });
      emitOrderChange(f);
      await vi.advanceTimersByTimeAsync(4_000);
      emitOrderChange(f);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('does not acquire a lease, refresh Google authorization or export unchanged data while idle', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.repository.acquireLease).toHaveBeenCalledOnce();
      expect(f.repository.loadReportSource).toHaveBeenCalledOnce();
      expect(f.oauth.refresh).toHaveBeenCalledOnce();
      expect(f.sheets.replaceReports).toHaveBeenCalledOnce();
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('advances the retirement cursor only after all Google writes finish successfully', async () => {
    const f = fixture();
    const before = {
      records: { bankCards: { createdAt: '2026-10-02T00:00:00.000123Z', id: 'card-100' } }
    };
    const after = {
      records: { bankCards: { createdAt: '2026-10-02T00:00:00.000123Z', id: 'card-200' } }
    };
    f.state.sourceVersions = { [GOOGLE_SHEETS_RETENTION_KEY]: writeGoogleSheetsRetention(before) };
    f.repository.loadReportSource.mockResolvedValue({
      orders: [],
      giftCards: [],
      renewals: [],
      financeJournals: [],
      chatgptAccounts: [],
      mailboxes: [],
      bankCards: [],
      customers: [],
      wallets: [],
      financeEntries: [],
      retention: after
    });
    f.sheets.replaceReports.mockRejectedValueOnce(new Error('fixture-google-failure'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await f.worker.runNow(true)).succeeded).toBe(false);
    expect((f.state.sourceVersions as Record<string, string>)[GOOGLE_SHEETS_RETENTION_KEY]).toBe(
      writeGoogleSheetsRetention(before)
    );
    expect((await f.worker.runNow(true)).succeeded).toBe(true);
    expect((f.state.sourceVersions as Record<string, string>)[GOOGLE_SHEETS_RETENTION_KEY]).toBe(
      writeGoogleSheetsRetention(after)
    );
    expect(f.repository.loadReportSource).toHaveBeenCalledWith(before);
  });

  it('reconciles a lost event from persisted versions and stops event handling on shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    f.repository.listSourceVersions.mockResolvedValue({ orders: '2' });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
    f.worker.onModuleDestroy();
    emitOrderChange(f);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
  });

  it('keeps changes received during an in-flight write for a follow-up sync', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const writing = deferred<undefined>();
    f.sheets.replaceReports.mockReturnValueOnce(writing.promise);
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledOnce();
      f.repository.listSourceVersions.mockResolvedValue({ orders: '2' });
      emitOrderChange(f);
      writing.resolve(undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
      expect(f.state.sourceVersions).toMatchObject({ orders: '2' });
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('backs off failed external writes even when new data keeps arriving', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture();
    f.sheets.replaceReports.mockRejectedValue(new Error('fixture-google-unavailable'));
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      for (let index = 0; index < 5; index += 1) {
        emitOrderChange(f);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(f.sheets.replaceReports).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
      emitOrderChange(f);
      await vi.advanceTimersByTimeAsync(55_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(3);
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('moves an existing report even when business versions did not change', async () => {
    const f = fixture();
    await f.worker.runNow(true);
    f.config.get.mockImplementation((key) =>
      key === 'GOOGLE_DRIVE_SYNC_FOLDER_ID' ? 'fixture-folder-123' : 'https://id.example.test'
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    expect((await f.worker.runNow(false)).succeeded).toBe(true);
    expect(f.sheets.ensureSpreadsheetInFolder).toHaveBeenCalledWith(
      'fixture-access',
      'fixture-file',
      'fixture-folder-123'
    );
    expect(f.sheets.createSpreadsheet).toHaveBeenCalledOnce();
  });

  it('upgrades an existing report without a destination folder even when source data is unchanged', async () => {
    const f = fixture();
    await f.worker.runNow(true);
    f.state.sourceVersions = { ...(f.state.sourceVersions as object), 'report-schema': '1' };
    const start = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(start + 10_000);
    expect((await f.worker.runNow(false)).succeeded).toBe(true);
    expect(f.sheets.createSpreadsheet).toHaveBeenCalledOnce();
    expect(f.sheets.ensureSpreadsheetInFolder).not.toHaveBeenCalled();
    expect(f.sheets.ensureReportSheets).toHaveBeenLastCalledWith('fixture-access', 'fixture-file', [
      '订单',
      '加卡',
      '续费',
      '财务汇总',
      'ChatGPT账号',
      '验证码邮箱',
      '银行卡',
      '客户',
      '开通',
      '钱包账户',
      '收支记账'
    ]);
    expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
    time.mockReturnValue(start + 20_000);
    expect((await f.worker.runNow(false)).skipped).toBe(true);
    expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
  });

  it('automatically exports a mailbox edit using its persisted workspace version', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.repository.listSourceVersions.mockResolvedValue({ orders: '1', workspace: '1' });
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      f.repository.listSourceVersions.mockResolvedValue({ orders: '1', workspace: '2' });
      f.changes.next({
        type: 'change',
        event: {
          schemaVersion: 1,
          eventId: 'mailbox-edit',
          occurredAt: new Date().toISOString(),
          scopes: [{ scope: 'workspace', version: '2' }]
        }
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
      expect(f.state.sourceVersions).toMatchObject({ workspace: '2' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.sheets.replaceReports).toHaveBeenCalledTimes(2);
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('retains the report file and checkpoint when the destination folder is inaccessible', async () => {
    const f = fixture();
    f.state.spreadsheetIdEncrypted = 'encrypted-fixture-file';
    f.state.sourceVersions = { orders: '0' };
    f.config.get.mockImplementation((key) =>
      key === 'GOOGLE_DRIVE_SYNC_FOLDER_ID' ? 'fixture-folder-123' : 'https://id.example.test'
    );
    f.sheets.ensureSpreadsheetInFolder.mockRejectedValue(
      new IdBusinessV2GoogleApiError('无法访问目标文件夹', 'GOOGLE_DRIVE_FOLDER_UNAVAILABLE', 404)
    );
    expect((await f.worker.runNow(true)).succeeded).toBe(false);
    expect(f.state.spreadsheetIdEncrypted).toBe('encrypted-fixture-file');
    expect(f.state.sourceVersions).toEqual({ orders: '0' });
    expect(f.sheets.replaceReports).not.toHaveBeenCalled();
  });

  it('completes a current authorization and consumes its state once', async () => {
    const f = fixture();
    expect(await f.service.completeAuthorization(callback)).toBe(true);
    expect(await f.service.completeAuthorization(callback)).toBe(false);
    expect(f.oauth.exchangeCode).toHaveBeenCalledTimes(1);
    expect(f.state.oauthVerifierEncrypted).toBeNull();
    expect(f.state.refreshTokenEncrypted).toBe('encrypted-fixture-new-refresh');
  });

  it('does not restore authorization after disconnect during the token exchange', async () => {
    const f = fixture();
    const token = deferred<{ refreshToken: string }>();
    f.oauth.exchangeCode.mockReturnValueOnce(token.promise);
    const completing = f.service.completeAuthorization(callback);
    await vi.waitFor(() => expect(f.oauth.exchangeCode).toHaveBeenCalled());
    await f.service.disconnect(operator);
    token.resolve({ refreshToken: 'fixture-new-refresh' });
    expect(await completing).toBe(false);
    expect(f.state.enabled).toBe(false);
    expect(f.state.refreshTokenEncrypted).toBeNull();
    expect(f.audit.append.mock.calls).toHaveLength(1);
  });

  it('rejects an old callback after reconfiguration and protects the new pending state', async () => {
    const f = fixture();
    const token = deferred<{ refreshToken: string }>();
    f.oauth.exchangeCode.mockReturnValueOnce(token.promise);
    const completing = f.service.completeAuthorization(callback);
    await vi.waitFor(() => expect(f.oauth.exchangeCode).toHaveBeenCalled());
    await f.service.saveConfig(
      { clientId: 'new-client.apps.googleusercontent.com', clientSecret: 'new-fixture-secret' },
      operator
    );
    f.state.oauthVerifierEncrypted = 'new-pending-verifier';
    token.resolve({ refreshToken: 'fixture-old-refresh' });
    expect(await completing).toBe(false);
    expect(f.state.refreshTokenEncrypted).toBeNull();
    expect(f.state.oauthVerifierEncrypted).toBe('new-pending-verifier');
  });

  it('atomically claims one of two concurrent callbacks', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.completeAuthorization(callback),
      f.service.completeAuthorization(callback)
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(f.oauth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnect', 'pause'] as const)(
    'stops subsequent external writes after %s during refresh',
    async (action) => {
      const f = fixture();
      const token = deferred<{ accessToken: string }>();
      f.oauth.refresh.mockReturnValueOnce(token.promise);
      const syncing = f.worker.runNow(true);
      await vi.waitFor(() => expect(f.oauth.refresh).toHaveBeenCalled());
      if (action === 'disconnect') await f.service.disconnect(operator);
      else await f.service.updateState({ enabled: false }, operator);
      token.resolve({ accessToken: 'fixture-access' });
      expect((await syncing).skipped).toBe(true);
      expect(f.sheets.createSpreadsheet).not.toHaveBeenCalled();
      expect(f.sheets.replaceReports).not.toHaveBeenCalled();
      expect(f.state.spreadsheetIdEncrypted).toBeNull();
    }
  );

  it('does not save a newly created file after reconfiguration during file creation', async () => {
    const f = fixture();
    const file = deferred<string>();
    f.sheets.createSpreadsheet.mockReturnValueOnce(file.promise);
    const syncing = f.worker.runNow(true);
    await vi.waitFor(() => expect(f.sheets.createSpreadsheet).toHaveBeenCalled());
    await f.service.saveConfig(
      { clientId: 'new-client.apps.googleusercontent.com', clientSecret: 'new-fixture-secret' },
      operator
    );
    file.resolve('fixture-file');
    expect((await syncing).skipped).toBe(true);
    expect(f.state.spreadsheetIdEncrypted).toBeNull();
    expect(f.sheets.replaceReports).not.toHaveBeenCalled();
  });

  it('does not record a cancelled sync as successful when an already sent write finishes', async () => {
    const f = fixture();
    f.state.spreadsheetIdEncrypted = 'encrypted-fixture-file';
    const writing = deferred<undefined>();
    f.sheets.replaceReports.mockReturnValueOnce(writing.promise);
    const syncing = f.worker.runNow(true);
    await vi.waitFor(() => expect(f.sheets.replaceReports).toHaveBeenCalled());
    await f.service.disconnect(operator);
    writing.resolve(undefined);
    expect((await syncing).succeeded).toBe(false);
    expect(f.state.lastSucceededAt).toBeUndefined();
    expect(f.state.sourceVersions).toEqual({});
    expect(f.state.spreadsheetIdEncrypted).toBeNull();
  });

  it('retains the normal create, write and successful-state flow', async () => {
    const f = fixture();
    expect((await f.worker.runNow(true)).succeeded).toBe(true);
    expect(f.sheets.replaceReports).toHaveBeenCalledTimes(1);
    expect(f.state.sourceVersions).toMatchObject({ orders: '1' });
  });

  it('contains timer failures before lease acquisition and keeps scheduling retries', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture();
    f.repository.acquireLease.mockRejectedValue(new Error('fixture-database-unavailable'));
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.repository.acquireLease).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      f.worker.onModuleDestroy();
    }
  });

  it('does not crash the scheduler when optional Google public URL configuration is absent', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture();
    f.state.enabled = false;
    f.config.get.mockReturnValue(undefined);
    f.worker.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(warn).toHaveBeenCalledOnce();
      expect(f.sheets.replaceReports).not.toHaveBeenCalled();
    } finally {
      f.worker.onModuleDestroy();
    }
  });
});
