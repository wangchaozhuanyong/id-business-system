export const GOOGLE_SHEETS_ROW_LIMIT = 10_000;
export const GOOGLE_SHEETS_TRIM_BATCH = 100;
export const GOOGLE_SHEETS_RETENTION_KEY = 'google-report-retention';
export const GOOGLE_SHEETS_RECORD_SOURCES = [
  'orders',
  'giftCards',
  'renewals',
  'chatgptAccounts',
  'mailboxes',
  'bankCards',
  'customers',
  'wallets',
  'financeEntries'
] as const;
export type GoogleSheetsRecordSource = (typeof GOOGLE_SHEETS_RECORD_SOURCES)[number];

export interface GoogleSheetsRetentionCursor {
  createdAt: string;
  id: string;
}
export interface GoogleSheetsReportRetention {
  records: Partial<Record<GoogleSheetsRecordSource, GoogleSheetsRetentionCursor>>;
  financeSummaryAfter?: string;
}

export function retainedGoogleSheetsRowCount(total: number) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Google 报表记录数无效');
  if (total < GOOGLE_SHEETS_ROW_LIMIT) return total;
  const batches = Math.floor((total - GOOGLE_SHEETS_ROW_LIMIT) / GOOGLE_SHEETS_TRIM_BATCH) + 1;
  return total - batches * GOOGLE_SHEETS_TRIM_BATCH;
}

export function retainGoogleSheetsRecords<T extends { createdAt: Date; id: string }>(
  newestFirst: T[],
  total: number,
  previous?: GoogleSheetsRetentionCursor
) {
  const keep = retainedGoogleSheetsRowCount(total);
  if (newestFirst.length < Math.min(total, GOOGLE_SHEETS_ROW_LIMIT))
    throw new Error('Google 报表保留窗口与记录数不一致');
  const removed = total > keep ? newestFirst[keep] : undefined;
  if (total > keep && !removed) throw new Error('Google 报表保留窗口与记录数不一致');
  return {
    rows: newestFirst.slice(0, keep).reverse(),
    cursor: removed ? { createdAt: removed.createdAt.toISOString(), id: removed.id } : previous
  };
}

export function readGoogleSheetsRetention(versions: unknown): GoogleSheetsReportRetention {
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return { records: {} };
  const text = (versions as Record<string, unknown>)[GOOGLE_SHEETS_RETENTION_KEY];
  if (text === undefined) return { records: {} };
  try {
    if (typeof text !== 'string') throw new Error();
    const state = JSON.parse(text) as {
      version?: unknown;
      records?: unknown;
      financeSummaryAfter?: unknown;
    };
    if (
      state.version !== 1 ||
      !state.records ||
      typeof state.records !== 'object' ||
      Array.isArray(state.records)
    )
      throw new Error();
    const records: GoogleSheetsReportRetention['records'] = {};
    for (const name of GOOGLE_SHEETS_RECORD_SOURCES) {
      const value = (state.records as Record<string, unknown>)[name];
      if (value === undefined) continue;
      if (!value || typeof value !== 'object') throw new Error();
      const cursor = value as GoogleSheetsRetentionCursor;
      if (
        typeof cursor.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(cursor.createdAt) ||
        new Date(cursor.createdAt).toISOString().slice(0, 19) !== cursor.createdAt.slice(0, 19) ||
        typeof cursor.id !== 'string' ||
        !/^[A-Za-z0-9-]{1,100}$/.test(cursor.id)
      )
        throw new Error();
      records[name] = { createdAt: cursor.createdAt, id: cursor.id };
    }
    if (
      state.financeSummaryAfter !== undefined &&
      (typeof state.financeSummaryAfter !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}:[a-z_]+$/.test(state.financeSummaryAfter))
    )
      throw new Error();
    return {
      records,
      ...(typeof state.financeSummaryAfter === 'string'
        ? { financeSummaryAfter: state.financeSummaryAfter }
        : {})
    };
  } catch {
    throw new Error('Google 报表保留状态无效，已停止同步以避免恢复被清理的旧行');
  }
}

export function writeGoogleSheetsRetention(state: GoogleSheetsReportRetention) {
  return JSON.stringify({ version: 1, ...state });
}
