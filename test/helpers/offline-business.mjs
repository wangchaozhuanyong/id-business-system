import { createLocalBusinessStore } from '../../server/local-business.mjs';
import { localBusinessRequest } from './local-business-request.mjs';
import { interceptDesign, origin } from './offline-design.mjs';

export async function offlineBusiness(t, page, { localFixtures = {}, role = 'admin' } = {}) {
  const actor = { id: 'local-operator', name: '本机操作员', role };
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const traffic = await interceptDesign(page.context(), {
    actor, skipRechargeAssets: true, localFixtures: {
      'auth/session': { actor, configured: true }, 'auth/order-owners': { items: [actor] }, ...localFixtures
    }
  });
  const request = (resource, options) => localBusinessRequest(store, resource, { actor, publicOrigin: origin, ...options });
  const respond = async route => {
    const browserRequest = route.request(), url = new URL(browserRequest.url());
    const resource = url.pathname.slice('/api/local/'.length) + url.search;
    return request(resource, {
      method: browserRequest.method(), body: browserRequest.postDataJSON() ?? undefined,
      operationId: browserRequest.headers()['x-id-operation']
    });
  };
  const fulfil = (route, { status, body }) => route.fulfill({ status, json: body });
  await page.context().route(url => url.origin === origin &&
    /^\/api\/local\/(?:appleBalance|batch|commerce|inventory(?:\/usage-correction)?|settings)$/.test(url.pathname),
    async route => fulfil(route, await respond(route)));
  return { request, respond, fulfil, traffic };
}
