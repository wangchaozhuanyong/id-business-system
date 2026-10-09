import { timingSafeEqual } from 'node:crypto';
import { json, type RequestHandler } from 'express';

/** 媒体只在内部 RPC 放宽正文上限，鉴权必须先于大正文解析。 */
export function createOnlineRechargeWorkerBodyParser(): RequestHandler {
  const parser = json({ limit: '140mb' });
  return (request, response, next) => {
    if (request.originalUrl.split('?')[0] !== '/api/id-business-v2/online-recharge/worker/rpc')
      return next();
    if (request.method !== 'POST') {
      response.status(405).json({ message: '内部接口仅支持提交' });
      return;
    }
    const expected = process.env.ONLINE_RECHARGE_WORKER_KEY;
    const supplied = request.headers['x-online-recharge-worker'];
    if (
      !expected ||
      expected.length < 32 ||
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      response.status(401).json({ message: '执行器身份校验失败' });
      return;
    }
    parser(request, response, next);
  };
}

/** 保留原批量导入容量；仅补货验签需要原始正文，客户会话按自身容量限制。 */
export function createOnlineRechargeBodyParser(): RequestHandler {
  const publicParser = json({ limit: '300kb' });
  const resourceParser = json({
    limit: '15mb',
    verify: (request, _response, bytes) => {
      if ((request.url ?? '').split('?')[0].endsWith('/webhooks/card-issue'))
        (request as typeof request & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
    }
  });
  return (request, response, next) => {
    if (request.path === '/worker/rpc') return next();
    const parser = request.path.startsWith('/public/') ? publicParser : resourceParser;
    parser(request, response, next);
  };
}
