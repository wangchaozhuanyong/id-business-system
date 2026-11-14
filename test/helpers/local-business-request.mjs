import { Readable } from 'node:stream';
import { handleLocalBusiness } from '../../server/local-business.mjs';

export async function localBusinessRequest(store, resource, { body, method = body === undefined ? 'GET' : 'POST',
  operationId, actor, publicOrigin, origin = publicOrigin, authorizeSensitive } = {}) {
  const url = '/api/local/' + resource;
  const instance = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(instance, { url, method, headers: { origin,
    ...(body !== undefined && { 'content-type': 'application/json' }),
    ...(operationId && { 'x-id-operation': operationId }) } });
  const result = {};
  await handleLocalBusiness(instance, {
    setHeader: (header, value) => { result[header] = value; },
    writeHead: status => { result.status = status; },
    end: text => { result.body = JSON.parse(text); }
  }, url.split('?')[0], store, actor, { publicOrigin, authorizeSensitive });
  return result;
}
