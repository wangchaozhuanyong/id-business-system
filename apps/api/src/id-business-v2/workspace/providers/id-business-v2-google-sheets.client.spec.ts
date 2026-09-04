import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2GoogleSheetsClient } from './id-business-v2-google-sheets.client';

describe('IdBusinessV2GoogleSheetsClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes RAW values before clearing every stale trailing row', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    await new IdBusinessV2GoogleSheetsClient().replaceReports('access-token', 'spreadsheet-id', [
      { name: '订单', rows: [['订单号'], ['ORDER-1']] }
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const writeRequest = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(writeRequest?.body))).toMatchObject({
      data: [{ range: "'订单'!A1", values: [['订单号'], ['ORDER-1']] }],
      valueInputOption: 'RAW'
    });
    const clearRequest = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(clearRequest?.body))).toEqual({
      ranges: ["'订单'!A3:X10001"]
    });
  });
});
