import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parseRechargeEmployeeAcceptanceOptions,
  rechargeEmployeeDatabaseName,
  rechargeEmployeeDatabaseTestFiles,
  validateRechargeEmployeeTestReport
} from './acceptance-v2-recharge-employee-concurrency.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = rechargeEmployeeDatabaseTestFiles;

function passingReport() {
  return {
    success: true,
    numTotalTests: 3,
    numPassedTests: 3,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: files.map((file) => ({
      name: resolve(root, 'apps/api', file),
      status: 'passed',
      assertionResults: [{ status: 'passed' }]
    }))
  };
}

test('default employee options retain Docker and legacy native selection', () => {
  assert.deepEqual(parseRechargeEmployeeAcceptanceOptions([], {}), {
    runtime: 'docker',
    extraFlags: [],
    combinedRelease: false
  });
  const options = parseRechargeEmployeeAcceptanceOptions(['--mysql-bin=/owned/mysql/bin'], {});
  assert.equal(options.runtime, 'native');
  assert.equal(options.mysqlBin, '/owned/mysql/bin');
  assert.equal(options.combinedRelease, false);
});

test('combined mode removes only the exact flag and retains owned runtime validation', () => {
  const environment = { GITHUB_ACTIONS: 'true' };
  const options = parseRechargeEmployeeAcceptanceOptions(
    ['--runtime=docker', '--combined-release'],
    environment
  );
  assert.equal(options.runtime, 'docker');
  assert.equal(options.combinedRelease, true);
  assert.throws(() =>
    parseRechargeEmployeeAcceptanceOptions(['--combined-release', '--unknown'], environment)
  );
  assert.throws(() =>
    parseRechargeEmployeeAcceptanceOptions(['--combined-release=true'], environment)
  );
  assert.throws(() =>
    parseRechargeEmployeeAcceptanceOptions(
      ['--combined-release', '--combined-release'],
      environment
    )
  );
});

test('combined mode requires the exact GitHub Actions environment value', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1'])
    assert.throws(
      () =>
        parseRechargeEmployeeAcceptanceOptions(['--combined-release'], { GITHUB_ACTIONS: value }),
      /仅允许在 GitHub Actions/
    );
});

test('combined database name satisfies each actual flow fixture guard without changing the default', () => {
  assert.match(rechargeEmployeeDatabaseName(false), /^id_business_v2_employee_connections_\d+$/);
  const pathname = '/' + rechargeEmployeeDatabaseName(true);
  for (const file of files.slice(1)) {
    const source = readFileSync(resolve(root, 'apps/api', file), 'utf8');
    const guard = source.match(/!\/(\^\\\/id_business_v2_[^/]+)\/\.test\(parsed\.pathname\)/);
    assert.ok(guard, `${file}: 必须保留实际隔离库名称校验`);
    assert.match(pathname, new RegExp(guard[1]), `${file}: 组合库名称不符合实际验收边界`);
  }
});

test('non-cloud CLI stops before any output, process or database startup', () => {
  const harness = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = [];
    for (const name of ['mkdirSync', 'writeFileSync', 'cpSync'])
      fs[name] = () => { calls.push(name); throw new Error('unexpected output'); };
    for (const name of ['spawn', 'spawnSync'])
      childProcess[name] = () => { calls.push(name); throw new Error('unexpected process'); };
    syncBuiltinESMExports();
    delete process.env.GITHUB_ACTIONS;
    process.argv = ['node', 'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
      '--combined-release', '--runtime=docker'];
    let message;
    try { await import('./scripts/acceptance-v2-recharge-employee-concurrency.mjs'); }
    catch (error) { message = error.message; }
    process.stdout.write(JSON.stringify({ calls, message }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', harness], {
      cwd: root,
      encoding: 'utf8'
    })
  );
  assert.deepEqual(result.calls, []);
  assert.match(result.message, /仅允许在 GitHub Actions/);
});

test('three actual files and their assertions produce closed counts', () => {
  assert.deepEqual(validateRechargeEmployeeTestReport(passingReport(), files), {
    testFiles: 3,
    testFilesPassed: 3,
    testsTotal: 3,
    testsPassed: 3,
    testsSkipped: 0,
    testsTodo: 0
  });
});

test('passing exit summaries cannot hide skipped, todo or failed assertions', () => {
  for (const field of [
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
    'numPendingTestSuites'
  ]) {
    const report = passingReport();
    report[field] = 1;
    assert.throws(() => validateRechargeEmployeeTestReport(report, files), field);
  }
  for (const status of ['skipped', 'pending', 'todo', 'failed']) {
    const report = passingReport();
    report.testResults[0].assertionResults[0].status = status;
    assert.throws(() => validateRechargeEmployeeTestReport(report, files), status);
  }
});

test('missing, duplicate, unexpected or empty files cannot masquerade as three passing files', () => {
  const missing = passingReport();
  missing.testResults.pop();
  const duplicate = passingReport();
  duplicate.testResults[1].name = duplicate.testResults[0].name;
  const unexpected = passingReport();
  unexpected.testResults[0].name = resolve(root, 'apps/api/src/unrelated.spec.ts');
  const empty = passingReport();
  empty.testResults[0].assertionResults = [];
  const failedFile = passingReport();
  failedFile.testResults[0].status = 'failed';
  for (const report of [missing, duplicate, unexpected, empty, failedFile])
    assert.throws(() => validateRechargeEmployeeTestReport(report, files));
});

test('inconsistent or zero test totals are rejected', () => {
  for (const total of [0, 2, 4]) {
    const report = passingReport();
    report.numTotalTests = report.numPassedTests = total;
    assert.throws(() => validateRechargeEmployeeTestReport(report, files));
  }
  const report = passingReport();
  report.numPassedTests = 2;
  assert.throws(() => validateRechargeEmployeeTestReport(report, files));
});
