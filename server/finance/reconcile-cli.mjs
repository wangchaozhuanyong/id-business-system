import { parseArgs } from 'node:util';

import { demoClock, demoOrders } from './reconcile-demo.mjs';
import { reconcileOrders } from './reconcile-orders.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new Error('请从标准输入传入独立新版的有效 JSON 导出，或使用 --demo');
  }
}

try {
  const { values } = parseArgs({
    options: { demo: { type: 'boolean' }, strict: { type: 'boolean' }, 'as-of': { type: 'string' } }
  });
  const clock = values['as-of'] !== undefined ? Date.parse(values['as-of']) :
    values.demo ? demoClock : Date.now();
  if (values['as-of'] !== undefined &&
      (!Number.isFinite(clock) || new Date(clock).toISOString() !== values['as-of']))
    throw new Error('--as-of 必须是标准 UTC ISO 时点，如 2026-11-05T06:00:00.000Z');
  const report = reconcileOrders(values.demo ? demoOrders() : await readInput(), { clock });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (values.strict && (report.counts.pending || report.batchIssues.length)) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`核对失败：${error.message}\n`);
  process.exitCode = 1;
}
