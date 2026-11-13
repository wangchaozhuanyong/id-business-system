import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { auditAppleWallets } from './finance/apple-wallet-audit.mjs';
import { reconcileOrders } from './finance/reconcile-orders.mjs';
import { auditInventoryLinkage } from './inventory-reconcile.mjs';
import { readBusinessAuditDocuments } from './local-business.mjs';
import { productionDataPaths } from './production-data.mjs';

async function readSnapshot(directory) {
  const { databasePath } = await productionDataPaths(directory);
  const keyFile = await open(databasePath + '.key', constants.O_RDONLY | constants.O_NOFOLLOW);
  const key = Buffer.alloc(32);
  try {
    const stat = await keyFile.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600 || stat.size !== key.length ||
        (await keyFile.read(key, 0, key.length, 0)).bytesRead !== key.length)
      throw new Error('无效的业务库密钥文件');
    return readBusinessAuditDocuments(databasePath, key);
  } finally {
    key.fill(0);
    await keyFile.close();
  }
}

try {
  const { values } = parseArgs({
    options: { 'data-dir': { type: 'string' }, 'as-of': { type: 'string' }, strict: { type: 'boolean' } }
  });
  const asOf = values['as-of'];
  const clock = asOf === undefined ? Date.now() : Date.parse(asOf);
  if (!values['data-dir'] || !Number.isFinite(clock) ||
      (asOf !== undefined && new Date(clock).toISOString() !== asOf)) throw new Error('核对参数无效');
  const documents = await readSnapshot(values['data-dir']);
  const input = Object.fromEntries(Object.entries(documents).map(([key, document]) => [key, document.data]));
  const inventory = auditInventoryLinkage(documents, { clock });
  const finance = reconcileOrders(input, { clock, fullCardHistory: true });
  const apple = auditAppleWallets(input);
  const versions = Object.fromEntries(Object.entries(documents).map(([key, document]) => [key, document.version]));
  const { eligible, review, oneSided, inconsistent } = inventory.counts;
  const outstanding = Boolean(eligible || review || oneSided || inconsistent || inventory.simulation.changedOnRepeat ||
    finance.operating.CNY.pending || finance.operating.MYR.pending || finance.batchIssues.length || apple.counts.issueCount);
  process.stdout.write(JSON.stringify({ asOf: finance.asOf, versions, outstanding, finance, inventory, apple }, null, 2) + '\n');
  if (values.strict && outstanding) process.exitCode = 2;
} catch {
  process.stderr.write('核对失败。请检查 --data-dir 的绝对路径、SQLite 业务库和原密钥，以及 --as-of 的 UTC ISO 格式。\n');
  process.exitCode = 1;
}
