import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { BlockList, createConnection, isIPv4 } from 'node:net';

const allowedHosts = new Set([
  'chatgpt.com',
  'auth.openai.com',
  'pay.openai.com',
  'cdn.oaistatic.com',
  'persistent.oaistatic.com',
  'js.stripe.com',
  'api.stripe.com',
  'checkout.stripe.com',
  'hooks.stripe.com',
  'm.stripe.com',
  'm.stripe.network',
  'r.stripe.com',
  'b.stripecdn.com'
]);
const blockedNetworks = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedNetworks.addSubnet(address, bits);

const clientAddress = process.env.CHECKOUT_DEBUG_CLIENT_IPV4;
if (!isIPv4(clientAddress)) throw new Error('需要设置调试容器的 IPv4 地址');

const server = createServer({ headersTimeout: 5000, maxHeaderSize: 4096 }, (_req, res) =>
  res.writeHead(405).end()
);
server.maxConnections = 96;
server.on('connect', async (req, client, head) => {
  const reply = (status) => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  const host = /^([a-z0-9.-]+):443$/i.exec(req.url)?.[1].toLowerCase();
  if (client.remoteAddress !== clientAddress || !allowedHosts.has(host))
    return reply('403 Forbidden');

  client.on('error', () => client.destroy());
  client.setTimeout(90_000, () => client.destroy());
  let records;
  try {
    records = await lookup(host, { family: 4, all: true });
  } catch {
    return reply('502 Bad Gateway');
  }
  if (client.destroyed) return;
  if (!records.length || records.some(({ address }) => blockedNetworks.check(address)))
    return reply('502 Bad Gateway');

  const upstream = createConnection({ host: records[0].address, port: 443 });
  let connected = false;
  client.once('close', () => upstream.destroy());
  upstream.setTimeout(8000, () => upstream.destroy(new Error('connect timeout')));
  upstream.once('error', () => {
    if (connected) client.destroy();
    else reply('502 Bad Gateway');
  });
  upstream.once('connect', () => {
    connected = true;
    upstream.setTimeout(90_000, () => upstream.destroy(new Error('idle timeout')));
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client).pipe(upstream);
  });
  upstream.once('close', () => {
    if (connected && !client.destroyed) client.end();
  });
});
server.listen(4380, '0.0.0.0');
