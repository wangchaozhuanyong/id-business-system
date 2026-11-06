import { legacyMicrosoftMailboxCallback } from './mailbox-microsoft.mjs';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

export const legacyWebsiteVisitIngest = '/api/id-business-v2/workspace-website-monitor/visits/ingest';

export function createLegacyToolRoutes({ publicOrigin, microsoftMailbox, handleWebsiteVisits }) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  if (!publicUrl || typeof microsoftMailbox?.handle !== 'function' || typeof handleWebsiteVisits !== 'function')
    throw new Error('旧版工具公开入口需要正式 HTTPS 地址和工具处理器');

  return async function handleLegacyToolRoute(request, response) {
    const path = request.url?.split('?', 1)[0];
    const callback = path === legacyMicrosoftMailboxCallback;
    if (!callback && path !== legacyWebsiteVisitIngest) return false;

    if (!toolRequestOrigin(request.headers, publicUrl)) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return true;
    }
    const method = callback ? 'GET' : 'POST';
    if (request.method !== method) {
      response.writeHead(405, { Allow: method, 'Cache-Control': 'no-store' }).end();
      return true;
    }
    if (callback) await microsoftMailbox.handle(request, response, 'callback');
    else await handleWebsiteVisits(request, response, 'ingest');
    return true;
  };
}
