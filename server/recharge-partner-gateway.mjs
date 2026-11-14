import { request } from 'node:http';
import { join } from 'node:path';
import { partnerTaskDirectoryName, partnerTaskSocketName } from '../modules/recharge/vendure/admission.mjs';

export function rechargePartnerGateway(directory) {
  const socketPath = join(directory, partnerTaskDirectoryName, partnerTaskSocketName);
  return (action, input) => new Promise((resolve, reject) => {
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
        if (response.statusCode === 404 && action === 'task') return resolve(null);
        if (response.statusCode === 400 && action === 'query') return resolve(null);
        if (response.statusCode === 409 && action === 'issue') return resolve(false);
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
}
