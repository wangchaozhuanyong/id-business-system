import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2GoogleSheetsClient } from './id-business-v2-google-sheets.client';

describe('IdBusinessV2GoogleSheetsClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockResponses(payloads: unknown[]) {
    const fetchMock = vi.fn<typeof fetch>();
    for (const payload of payloads) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
      );
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const folder = {
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    capabilities: { canAddChildren: true }
  };

  it('writes expanded reports in bounded batches with continuous row ranges before clearing stale rows', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const rows = [
      ['邮箱地址'],
      ...Array.from({ length: 8_000 }, (_, index) => [String(index), '测试'.repeat(70)])
    ];
    await new IdBusinessV2GoogleSheetsClient().replaceReports('fixture-access', 'fixture-file', [
      { name: '验证码邮箱', rows },
      { name: '客户', rows: [['名称'], ['测试客户']] }
    ]);
    const writes = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/values:batchUpdate')
    );
    expect(writes.length).toBeGreaterThan(1);
    const exported: string[][] = [];
    for (const [, request] of writes) {
      expect(Buffer.byteLength(String(request?.body), 'utf8')).toBeLessThanOrEqual(1_000_000);
      const body = JSON.parse(String(request?.body)) as {
        data: Array<{ range: string; values: string[][] }>;
      };
      for (const part of body.data.filter(({ range }) => range.startsWith("'验证码邮箱'!"))) {
        expect(part.range).toBe(`'验证码邮箱'!A${exported.length + 1}`);
        exported.push(...part.values);
      }
    }
    expect(exported).toEqual(rows);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/values:batchClear');
  });

  it('stops between batches when the current lease or authorization is cancelled', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const canContinue = vi
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const rows = Array.from({ length: 8_000 }, () => ['测试'.repeat(70)]);
    await expect(
      new IdBusinessV2GoogleSheetsClient().replaceReports(
        'fixture-access',
        'fixture-file',
        [{ name: '客户', rows }],
        canContinue
      )
    ).rejects.toThrow('Google 同步任务已取消或租约已到期');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(canContinue).toHaveBeenCalledTimes(2);
  });

  it('does not clear stale data after a failed middle batch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockRejectedValueOnce(new Error('fixture-unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new IdBusinessV2GoogleSheetsClient().replaceReports('fixture-access', 'fixture-file', [
        { name: '客户', rows: Array.from({ length: 8_000 }, () => ['测试'.repeat(70)]) }
      ])
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain('/values:batchUpdate');
  });

  it('creates a report directly in the destination folder before initializing any cells', async () => {
    const fetchMock = mockResponses([folder, { id: 'fixture-sheet' }]);
    expect(
      await new IdBusinessV2GoogleSheetsClient().createSpreadsheet(
        'fixture-access',
        ['订单'],
        'fixture-folder'
      )
    ).toBe('fixture-sheet');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('drive/v3/files?');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      parents: ['fixture-folder'],
      mimeType: 'application/vnd.google-apps.spreadsheet'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...folder, trashed: true },
    { ...folder, capabilities: { canAddChildren: false } },
    { ...folder, mimeType: 'application/vnd.google-apps.spreadsheet' }
  ])(
    'does not create files for a deleted, read-only or non-folder destination',
    async (invalidFolder) => {
      const fetchMock = mockResponses([invalidFolder]);
      await expect(
        new IdBusinessV2GoogleSheetsClient().createSpreadsheet(
          'fixture-access',
          ['订单'],
          'fixture-folder'
        )
      ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_FOLDER_UNAVAILABLE' });
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it('moves an existing report by updating its parents and preserves its file ID', async () => {
    const fetchMock = mockResponses([
      { parents: ['old-folder'] },
      folder,
      { parents: ['fixture-folder'] }
    ]);
    await new IdBusinessV2GoogleSheetsClient().ensureSpreadsheetInFolder(
      'fixture-access',
      'fixture-sheet',
      'fixture-folder'
    );
    const url = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(url.pathname).toBe('/drive/v3/files/fixture-sheet');
    expect(url.searchParams.get('addParents')).toBe('fixture-folder');
    expect(url.searchParams.get('removeParents')).toBe('old-folder');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('PATCH');
  });

  it('does not move a report already in the requested folder', async () => {
    const fetchMock = mockResponses([{ parents: ['fixture-folder'] }]);
    await new IdBusinessV2GoogleSheetsClient().ensureSpreadsheetInFolder(
      'fixture-access',
      'fixture-sheet',
      'fixture-folder'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/files/fixture-sheet?fields=parents');
  });

  it('classifies a folder disappearing during the move without treating the report as deleted', async () => {
    const fetchMock = mockResponses([{ parents: ['old-folder'] }, folder]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 })
    );
    await expect(
      new IdBusinessV2GoogleSheetsClient().ensureSpreadsheetInFolder(
        'fixture-access',
        'fixture-sheet',
        'fixture-folder'
      )
    ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_FOLDER_UNAVAILABLE', status: 404 });
  });

  it('recovers missing tabs on the saved file without recreating existing tabs', async () => {
    const fetchMock = mockResponses([
      { sheets: [{ properties: { sheetId: 0, title: '订单' } }] },
      { replies: [{ addSheet: { properties: { sheetId: 1 } } }] },
      {}
    ]);
    await new IdBusinessV2GoogleSheetsClient().ensureReportSheets(
      'fixture-access',
      'fixture-sheet',
      ['订单', '加卡']
    );
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request.requests).toHaveLength(1);
    expect(request.requests[0].addSheet.properties.title).toBe('加卡');
    expect(request.requests[0].addSheet.properties.gridProperties.rowCount).toBe(10001);
  });

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
