import { parseArgs } from 'node:util';
import { auditInventoryLinkage } from './inventory-reconcile.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { throw new Error('请从标准输入传入库存和订单 JSON 快照'); }
}

try {
  const { values } = parseArgs({ options: { 'as-of': { type: 'string' }, strict: { type: 'boolean' } } });
  const asOf = values['as-of'];
  const clock = asOf === undefined ? Date.now() : Date.parse(asOf);
  if (asOf !== undefined && (!Number.isFinite(clock) || new Date(clock).toISOString() !== asOf))
    throw new Error('--as-of 必须是标准 UTC ISO 时点，如 2026-11-13T06:00:00.000Z');
  const report = auditInventoryLinkage(await readInput(), { clock });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const { eligible, review, inconsistent } = report.counts;
  if (values.strict && (eligible || review || inconsistent || report.simulation.changedOnRepeat))
    process.exitCode = 2;
} catch {
  process.stderr.write('核对失败。请检查参数、UTC 时点及库存和订单 JSON 的完整性。\n');
  process.exitCode = 1;
}
