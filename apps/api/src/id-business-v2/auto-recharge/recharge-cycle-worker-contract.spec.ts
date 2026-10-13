import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { V2RechargeNextCyclePreparationResult } from '@apple-business/shared';
import { cycleFixture } from './recharge-cycle-test-fixture';
import { readCycleState } from './recharge-cycle-state';

const project = resolve(__dirname, '../../../../..');
const worker = resolve(project, 'apps/api/src/id-business-v2/auto-recharge/worker');
const installedPython = resolve(
  homedir(),
  'Library/Application Support/IDBusinessV2AutoRechargeConnector/venv/bin/python'
);
const python = existsSync(installedPython) ? installedPython : 'python3';
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);
const available =
  spawnSync(python, ['-c', 'import playwright'], { env, timeout: 5000 }).status === 0;

it.skipIf(!available)(
  '实际API周期回包经Python账本生成首标记后，只能由API消费一次，原历史完整保留',
  async () => {
    const accountId = 'synthetic-cycle-contract-account';
    const f = cycleFixture(true, 'plus', accountId);
    // AttemptLedger's root document retains the official plan name; payment
    // documents use target_plan. Include the real root shape in this bridge.
    Object.assign(
      f.records.find((record) => record.fileKey === f.accountKey + '.json')!.document as object,
      {
        plan: 'chatgptplusplan'
      }
    );
    const inspected = (await f.prepare('inspect', {
      subscription_inspection: f.inspection()
    })) as V2RechargeNextCyclePreparationResult;
    const committed = (await f.prepare('commit', {
      reviewDigest: inspected.cycleReview.reviewDigest,
      subscription_inspection: f.inspection({ checked_at: new Date().toISOString() })
    })) as V2RechargeNextCyclePreparationResult;
    expect(committed.nextCycleContext?.grant?.status).toBe('granted');
    const output = resolve(project, '.runtime/recharge-flow-fixes-20261013/contract');
    mkdirSync(output, { recursive: true });
    const transferred = spawnSync(
      python,
      [
        '-c',
        `import sys,json,tempfile,copy
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import attempt_ledger,subscription_cycle
from checkout_core import write_json
packet=json.load(sys.stdin)
context=packet['response']['nextCycleContext']
grant=copy.deepcopy(context['grant'])
assert subscription_cycle.grant_valid(grant,context['accountKey'],context['targetPlan'],job_id=context['jobId'])
captured=[]
with tempfile.TemporaryDirectory(dir=sys.argv[2]) as folder:
    root=Path(folder)
    for record in packet['response']['records']:
        path=root/record['fileKey']
        assert root in path.resolve().parents
        path.parent.mkdir(parents=True,exist_ok=True)
        write_json(path,record['document'],exclusive=True)
        if record['fileKey'].startswith('history/'):
            assert len(record['fileKey'])==77
        elif record['fileKey'].startswith('payments/'):
            assert subscription_cycle.closed_payment_allowed(record['document'],grant)
    attempt_ledger.atomic_json=lambda path,document: captured.append(copy.deepcopy(document))
    with attempt_ledger.AttemptLedger(root,packet['accountId'],target_plan=context['targetPlan'],next_cycle_grant=grant) as ledger:
        ledger.begin()
        assert ledger.record is not None
    assert len(captured)==1 and grant['status']=='consumed'
print(json.dumps({'marker':captured[0],'historyPreserved':True}))`,
        worker,
        output
      ],
      {
        env,
        input: JSON.stringify({ accountId, response: committed }),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 512 * 1024,
        cwd: worker
      }
    );
    // Arguments include only local paths; synthetic protocol data stays on stdin.
    expect(transferred.status, transferred.stderr).toBe(0);
    const result = JSON.parse(transferred.stdout) as {
      marker: Record<string, unknown>;
      historyPreserved: boolean;
    };
    const grant = committed.nextCycleContext!.grant!;
    const callback = {
      type: 'ledger',
      accountKey: f.accountKey,
      fileKey: grant.checkoutFileKey,
      revision: grant.checkoutRevision,
      document: result.marker
    };
    const saved = await f.callback(callback);
    expect(saved).toEqual({ revision: grant.checkoutRevision + 1 });
    expect(await f.callback(callback)).toEqual({
      revision: grant.checkoutRevision + 1,
      replayed: true
    });
    expect(readCycleState(f.job)?.grant?.status).toBe('consumed');
    expect(result.historyPreserved).toBe(true);
    expect(
      f.records
        .filter((record) => record.fileKey.startsWith('payments/'))
        .every((record) => (record.document as Record<string, unknown>).payment_status === 'paid')
    ).toBe(true);
    await expect(
      f.callback({ ...callback, document: { ...result.marker, run_id: 'b'.repeat(32) } })
    ).rejects.toThrow('原操作');
  },
  15000
);
