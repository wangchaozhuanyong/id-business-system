import { request } from 'node:http';
import { readProgressStream } from '../modules/recharge/vendure/progress-stream.mjs';
import { join } from 'node:path';
import { partnerTaskDirectoryName, partnerTaskSocketName } from '../modules/recharge/vendure/admission.mjs';

export function rechargePartnerGateway(directory) {
  const socketPath = join(directory, partnerTaskDirectoryName, partnerTaskSocketName);
  const gateway = (action, input) => new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = request({
      socketPath, path: '/' + action, method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, async response => {
      try {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > 4096) throw new Error('Invalid gateway response');
          chunks.push(chunk);
        }
        if (response.statusCode === 404 && ['task', 'review-lookup', 'review-release'].includes(action)) return resolve(null);
        if (response.statusCode === 400 && action === 'query') return resolve(null);
        if (response.statusCode === 409 && ['issue', 'review-release'].includes(action)) return resolve(false);
        if (response.statusCode !== 200) throw new Error('Partner gateway unavailable');
        resolve(JSON.parse(Buffer.concat(chunks)));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(body);
  });
  gateway.watch = (input, signal, onTask) => new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = request({ socketPath, path: '/task', method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) }
    }, async response => {
      clearTimeout(connectTimeout);
      response.setTimeout(45000, () => response.destroy(new Error('Progress heartbeat timeout')));
      try {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream'))
          throw new Error('Progress stream unavailable');
        await readProgressStream(response, onTask); resolve();
      } catch (error) { response.destroy(); reject(error); }
    });
    const connectTimeout = setTimeout(() => req.destroy(new Error('Progress connection timeout')), 10000);
    req.once('error', error => { clearTimeout(connectTimeout); reject(error); });
    req.end(body);
  });
  return gateway;
}
