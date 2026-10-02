import { describe, expect, it } from 'vitest';
import {
  GOOGLE_SHEETS_RETENTION_KEY,
  readGoogleSheetsRetention,
  retainedGoogleSheetsRowCount,
  retainGoogleSheetsRecords,
  writeGoogleSheetsRetention
} from './id-business-v2-google-sheets-retention';

describe('Google Sheets rolling retention', () => {
  it.each([
    [0, 0],
    [9_999, 9_999],
    [10_000, 9_900],
    [10_001, 9_901],
    [10_099, 9_999],
    [10_100, 9_900],
    [50_050, 9_950]
  ])('keeps %i source rows as %i report rows after complete batches of 100', (total, expected) => {
    expect(retainedGoogleSheetsRowCount(total)).toBe(expected);
  });

  it('removes the oldest 100 and outputs older records first without changing source rows', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: `record-${String(10_000 - index).padStart(6, '0')}`,
      createdAt: new Date('2026-10-02T00:00:00Z')
    }));
    const retained = retainGoogleSheetsRecords(rows, 10_000);
    expect(retained.rows).toHaveLength(9_900);
    expect(retained.rows[0]!.id).toBe('record-000101');
    expect(retained.rows.at(-1)!.id).toBe('record-010000');
    expect(retained.cursor?.id).toBe('record-000100');
    expect(rows).toHaveLength(10_000);
    expect(rows[0]!.id).toBe('record-010000');
  });

  it('round-trips only the bounded retirement cursors including database microseconds', () => {
    const state = {
      records: { customers: { createdAt: '2026-10-02T00:00:00.000123Z', id: 'customer-100' } },
      financeSummaryAfter: '2026-10-02:cash'
    };
    expect(
      readGoogleSheetsRetention({
        [GOOGLE_SHEETS_RETENTION_KEY]: writeGoogleSheetsRetention(state)
      })
    ).toEqual(state);
    expect(readGoogleSheetsRetention({ orders: '1' })).toEqual({ records: {} });
    expect(() => readGoogleSheetsRetention({ [GOOGLE_SHEETS_RETENTION_KEY]: '{invalid' })).toThrow(
      '保留状态无效'
    );
  });
});
