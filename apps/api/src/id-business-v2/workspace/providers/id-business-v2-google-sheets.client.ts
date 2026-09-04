import { Injectable } from '@nestjs/common';
import { idBusinessV2GoogleApiFetchJson } from './id-business-v2-google-api-http';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const REPORT_TITLE = 'ID 业务管理系统 - 实时业务报表';
const MAX_ROWS_PER_REPORT = 10_000;

export interface IdBusinessV2GoogleSheetReport {
  name: string;
  rows: string[][];
}

@Injectable()
export class IdBusinessV2GoogleSheetsClient {
  async createSpreadsheet(accessToken: string, reportNames: readonly string[]) {
    const created = await idBusinessV2GoogleApiFetchJson<{
      spreadsheetId?: unknown;
      sheets?: Array<{ properties?: { sheetId?: unknown } }>;
    }>(SHEETS_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        properties: { locale: 'zh_CN', timeZone: 'Asia/Shanghai', title: REPORT_TITLE },
        sheets: reportNames.map((title) => ({
          properties: {
            gridProperties: {
              columnCount: 24,
              frozenRowCount: 1,
              rowCount: MAX_ROWS_PER_REPORT + 1
            },
            title
          }
        }))
      })
    });
    if (typeof created.spreadsheetId !== 'string' || !created.spreadsheetId) {
      throw new Error('Google 没有返回报表文件编号');
    }
    const sheetIds = (created.sheets ?? [])
      .map((sheet) => sheet.properties?.sheetId)
      .filter((sheetId): sheetId is number => typeof sheetId === 'number');
    if (sheetIds.length) await this.formatSheets(accessToken, created.spreadsheetId, sheetIds);
    return created.spreadsheetId;
  }

  async replaceReports(
    accessToken: string,
    spreadsheetId: string,
    reports: readonly IdBusinessV2GoogleSheetReport[]
  ) {
    await idBusinessV2GoogleApiFetchJson(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeoutMs: 60_000,
        body: JSON.stringify({
          data: reports.map((report) => ({
            majorDimension: 'ROWS',
            range: `${this.sheetName(report.name)}!A1`,
            values: report.rows
          })),
          includeValuesInResponse: false,
          valueInputOption: 'RAW'
        })
      }
    );

    const staleRanges = reports
      .map((report) => {
        const lastRow = MAX_ROWS_PER_REPORT + 1;
        const start = report.rows.length + 1;
        return start <= lastRow ? `${this.sheetName(report.name)}!A${start}:X${lastRow}` : null;
      })
      .filter((range): range is string => Boolean(range));
    if (!staleRanges.length) return;
    await idBusinessV2GoogleApiFetchJson(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ranges: staleRanges })
      }
    );
  }

  spreadsheetUrl(spreadsheetId: string) {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
  }

  private async formatSheets(accessToken: string, spreadsheetId: string, sheetIds: number[]) {
    await idBusinessV2GoogleApiFetchJson(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          requests: sheetIds.flatMap((sheetId) => [
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.12, green: 0.35, blue: 0.86 },
                    horizontalAlignment: 'CENTER',
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                  }
                },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)'
              }
            },
            {
              autoResizeDimensions: {
                dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 24 }
              }
            }
          ])
        })
      }
    );
  }

  private sheetName(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
