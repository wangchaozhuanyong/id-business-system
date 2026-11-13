import { isAbsolute, resolve } from 'node:path';
import { reportColumns } from '../backup/sheets-source.mjs';
import { readSheetsSyncStatus } from '../monitoring-worker-receipts.mjs';

export const sheetsStatusRoute = '/api/local/tools/sheets-status';
const tabs = Object.entries(reportColumns).map(([name, columns]) => ({ name, columns }));

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(body));
}

export function createSheetsStatusHandler({
  receiptDirectory, collectorDirectory, dataDirectory, publicOrigin, clock = Date.now,
  readCollectorReceipt
}) {
  const validDirectory = directory => dataDirectory && isAbsolute(directory || '') &&
    resolve(directory) !== resolve(dataDirectory);
  const workerReports = validDirectory(receiptDirectory);
  const collectorReports = validDirectory(collectorDirectory);

  return async (request, response, actor) => {
    if (!actor?.id) return json(response, 401, { error: '请先登录', reason: request.localAuthReason || 'invalid' });
    if (!['admin', 'super'].includes(actor.role)) return json(response, 403, { error: '当前账号无权查看同步状态' });
    const origin = publicOrigin || 'http://' + request.headers.host;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return json(response, 403, { error: '请求来源未通过校验' });
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return json(response, 405, { error: '此接口仅可读取同步状态' });
    }

    const { state, reportedAt, verifiedAt, failures } = await readSheetsSyncStatus({
      workerDirectory: workerReports ? receiptDirectory : undefined,
      collectorDirectory: collectorReports ? collectorDirectory : undefined,
      now: clock(), readCollector: readCollectorReceipt
    });
    return json(response, 200, { state, reportedAt, verifiedAt, failures, tabs });
  };
}
