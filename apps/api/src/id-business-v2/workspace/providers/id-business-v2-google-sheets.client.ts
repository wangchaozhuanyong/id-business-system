import { Injectable } from '@nestjs/common';
import {
  IdBusinessV2GoogleApiError,
  idBusinessV2GoogleApiFetchJson
} from './id-business-v2-google-api-http';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const REPORT_TITLE = 'ID 业务管理系统 - 实时业务报表';
const MAX_ROWS_PER_REPORT = 10_000;
const MAX_VALUE_BATCH_BYTES = 1_000_000;

interface SheetValues {
  majorDimension: 'ROWS';
  range: string;
  values: string[][];
}

export interface IdBusinessV2GoogleSheetReport {
  name: string;
  rows: string[][];
}

@Injectable()
export class IdBusinessV2GoogleSheetsClient {
  async createSpreadsheet(
    accessToken: string,
    reportNames: readonly string[],
    folderId?: string | null
  ) {
    if (folderId) {
      await this.validateFolder(accessToken, folderId);
      const created = await idBusinessV2GoogleApiFetchJson<{ id?: string }>(
        `${DRIVE_FILES_API}?fields=id&supportsAllDrives=true`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            name: REPORT_TITLE,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [folderId]
          })
        }
      );
      if (typeof created.id !== 'string' || !created.id)
        throw new Error('Google 没有返回报表文件编号');
      // Save this ID before initializing tabs so failed initialization can retry the same file.
      return created.id;
    }
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

  async ensureSpreadsheetInFolder(accessToken: string, spreadsheetId: string, folderId: string) {
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(spreadsheetId)}`;
    const file = await idBusinessV2GoogleApiFetchJson<{ parents?: string[] }>(
      `${url}?fields=parents&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    // A report manually moved by its owner already proves the destination membership.
    // drive.file may allow this report without exposing unrelated folder metadata.
    if (file.parents?.includes(folderId)) return;
    await this.validateFolder(accessToken, folderId);
    const params = new URLSearchParams({
      addParents: folderId,
      fields: 'parents',
      supportsAllDrives: 'true'
    });
    if (file.parents?.length) params.set('removeParents', file.parents.join(','));
    let moved: { parents?: string[] };
    try {
      moved = await idBusinessV2GoogleApiFetchJson(`${url}?${params}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: '{}'
      });
    } catch (error) {
      // A destination can disappear between validation and the move. Keep the saved report ID.
      if (error instanceof IdBusinessV2GoogleApiError && [403, 404].includes(error.status ?? 0)) {
        throw new IdBusinessV2GoogleApiError(
          '无法移入目标文件夹，请核对应用的文件夹访问权限。',
          'GOOGLE_DRIVE_FOLDER_UNAVAILABLE',
          error.status
        );
      }
      throw error;
    }
    if (!moved.parents?.includes(folderId)) throw new Error('Google 报表尚未移入目标文件夹');
  }

  async ensureReportSheets(
    accessToken: string,
    spreadsheetId: string,
    reportNames: readonly string[]
  ) {
    const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}`;
    const metadata = await idBusinessV2GoogleApiFetchJson<{
      sheets?: Array<{ properties: { sheetId: number; title: string } }>;
    }>(`${url}?fields=sheets.properties(sheetId,title)`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const titles = new Set(metadata.sheets?.map((sheet) => sheet.properties.title));
    const missing = reportNames.filter((title) => !titles.has(title));
    if (!missing.length) return;
    const result = await idBusinessV2GoogleApiFetchJson<{
      replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
    }>(`${url}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        requests: missing.map((title) => ({
          addSheet: {
            properties: {
              title,
              gridProperties: {
                columnCount: 24,
                frozenRowCount: 1,
                rowCount: MAX_ROWS_PER_REPORT + 1
              }
            }
          }
        }))
      })
    });
    const sheetIds = (result.replies ?? []).flatMap((reply) =>
      typeof reply.addSheet?.properties?.sheetId === 'number'
        ? [reply.addSheet.properties.sheetId]
        : []
    );
    if (sheetIds.length) await this.formatSheets(accessToken, spreadsheetId, sheetIds);
  }

  private async validateFolder(accessToken: string, folderId: string) {
    let folder: {
      mimeType?: string;
      trashed?: boolean;
      capabilities?: { canAddChildren?: boolean };
    };
    try {
      folder = await idBusinessV2GoogleApiFetchJson(
        `${DRIVE_FILES_API}/${encodeURIComponent(folderId)}?fields=mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch (error) {
      if (error instanceof IdBusinessV2GoogleApiError && [403, 404].includes(error.status ?? 0)) {
        throw new IdBusinessV2GoogleApiError(
          '无法访问目标文件夹，请核对文件夹编号与应用的访问授权。',
          'GOOGLE_DRIVE_FOLDER_UNAVAILABLE',
          error.status
        );
      }
      throw error;
    }
    if (
      folder.mimeType !== 'application/vnd.google-apps.folder' ||
      folder.trashed ||
      !folder.capabilities?.canAddChildren
    ) {
      throw new IdBusinessV2GoogleApiError(
        '目标必须是可写入且未删除的 Google 网盘文件夹。',
        'GOOGLE_DRIVE_FOLDER_UNAVAILABLE'
      );
    }
  }

  async replaceReports(
    accessToken: string,
    spreadsheetId: string,
    reports: readonly IdBusinessV2GoogleSheetReport[],
    canContinue?: () => Promise<boolean>
  ) {
    for (const data of this.valueBatches(reports)) {
      if (canContinue && !(await canContinue()))
        throw new Error('Google 同步任务已取消或租约已到期');
      await idBusinessV2GoogleApiFetchJson(
        `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          timeoutMs: 60_000,
          body: JSON.stringify({
            data,
            includeValuesInResponse: false,
            valueInputOption: 'RAW'
          })
        }
      );
    }

    const staleRanges = reports
      .map((report) => {
        const lastRow = MAX_ROWS_PER_REPORT + 1;
        const start = report.rows.length + 1;
        return start <= lastRow ? `${this.sheetName(report.name)}!A${start}:X${lastRow}` : null;
      })
      .filter((range): range is string => Boolean(range));
    if (!staleRanges.length) return;
    if (canContinue && !(await canContinue())) throw new Error('Google 同步任务已取消或租约已到期');
    await idBusinessV2GoogleApiFetchJson(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ranges: staleRanges })
      }
    );
  }

  private *valueBatches(reports: readonly IdBusinessV2GoogleSheetReport[]) {
    let data: SheetValues[] = [];
    let bytes = 150;
    for (const report of reports) {
      let segment: SheetValues | null = null;
      for (let index = 0; index < report.rows.length; index += 1) {
        const row = report.rows[index]!;
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        if (rowBytes + 406 > MAX_VALUE_BATCH_BYTES) throw new Error('单条 Google 报表记录过长');
        if (bytes + rowBytes + (segment ? 0 : 256) > MAX_VALUE_BATCH_BYTES) {
          yield data;
          data = [];
          bytes = 150;
          segment = null;
        }
        if (!segment) {
          segment = {
            majorDimension: 'ROWS',
            range: `${this.sheetName(report.name)}!A${index + 1}`,
            values: []
          };
          data.push(segment);
          bytes += 256;
        }
        segment.values.push(row);
        bytes += rowBytes;
      }
    }
    if (data.length) yield data;
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
