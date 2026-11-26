import { parseArgs } from 'node:util';
import { createLocalBusinessStore, readRechargeDebugCleanupDocuments } from './local-business.mjs';
import { createOrderRechargeClient } from './order-recharge-client.mjs';
import { productionDataPaths } from './production-data.mjs';
import { planRechargeDebugCleanup, readRechargeDebugEvidence } from './recharge-debug-cleanup.mjs';

try {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string' }, 'codexdaichong-url': { type: 'string' },
    'order-no': { type: 'string', multiple: true }, apply: { type: 'string' },
    'restored-backup-dir': { type: 'string' }
  } });
  const orderNos = values['order-no'] && new Set(values['order-no']);
  const confirmation = values.apply;
  const backupDirectory = values['restored-backup-dir'];
  if (!values['codexdaichong-url'] ||
      (orderNos && [...orderNos].some(orderNo => !/^OD-LOCAL-\d{1,12}$/.test(orderNo))) ||
      Boolean(confirmation) !== Boolean(backupDirectory) ||
      (confirmation && (!/^[a-f0-9]{64}$/.test(confirmation) || !orderNos?.size)))
    throw new Error('请指定原版只读接口，正式清理须附带已确认的订单号、清单摘要和隔离恢复目录');
  const { databasePath } = await productionDataPaths(values['data-dir']);
  const documents = readRechargeDebugCleanupDocuments(databasePath);
  const client = createOrderRechargeClient({
    upstreamUrl: values['codexdaichong-url'], secret: process.env.ID_RECHARGE_BRIDGE_SECRET
  });
  const verified = await readRechargeDebugEvidence(documents, client, orderNos);
  let result = planRechargeDebugCleanup(documents, verified, orderNos);
  if (confirmation) {
    const backup = await productionDataPaths(backupDirectory);
    if (backup.databasePath === databasePath) throw new Error('隔离恢复目录不能指向当前业务库');
    const restoredBackup = readRechargeDebugCleanupDocuments(backup.databasePath);
    const store = createLocalBusinessStore(databasePath);
    try { result = store.removeRechargeDebugOrders({ verified, orderNos, confirmation, restoredBackup }); }
    finally { store.close(); }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write('调试订单核对或清理失败。' +
    (error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '请检查指定路径、备份和原版只读接口。') + '\n');
  process.exitCode = 1;
}
