import { httpServerHandler } from 'cloudflare:node';
import { createCloudflareV2HttpServer } from '../../apps/api/dist-cloudflare/cloudflare-v2-bootstrap.js';
import { runWithCloudflarePrisma } from '../../apps/api/dist-cloudflare/common/prisma/cloudflare-prisma.service.js';

const handlerPromise = createNestHandler();

export default {
  async fetch(request, env, context) {
    return runWithCloudflarePrisma(async () => {
      const handler = await handlerPromise;
      return handler.fetch(request, env, context);
    }, env.HYPERDRIVE?.connectionString);
  }
};

async function createNestHandler() {
  const server = await createCloudflareV2HttpServer();
  return httpServerHandler(server);
}
