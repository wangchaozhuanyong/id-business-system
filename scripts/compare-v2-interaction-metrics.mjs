import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const percentile = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

// Input comes from an isolated preview benchmark, not fault-injection scenarios.
// conditions identifies the device, viewport, network and fixture revision.
export function compareInteractionMetrics(current, baseline) {
  assert.ok(current.conditions && baseline?.conditions, '缺少同条件基线，不能宣称性能回归验收通过');
  assert.deepEqual(current.conditions, baseline.conditions, '设备、网络、视口或夹具不同，不能比较');
  const group = (report) => {
    const groups = new Map();
    for (const row of report.samples ?? []) {
      assert.match(row.path, /^\/v2\/[a-z/-]+$/, '只允许无业务标识和搜索词的登记路由');
      const key = `${row.path}:${row.dataSource}`;
      const rows = groups.get(key) ?? [];
      rows.push(row);
      groups.set(key, rows);
    }
    return groups;
  };
  const previous = group(baseline),
    results = [];
  for (const [key, rows] of group(current)) {
    const before = previous.get(key);
    assert.ok(rows.length >= 20 && before?.length >= 20, `${key} 前后各需至少20个样本`);
    const values = rows.map((row) => row.paintMs);
    assert.ok(
      values.every((value) => Number.isFinite(value) && value >= 0),
      '缺少真实内容首帧耗时'
    );
    const previousValues = before.map((row) => row.paintMs);
    assert.ok(
      previousValues.every((value) => Number.isFinite(value) && value >= 0),
      '基线缺少内容首帧耗时'
    );
    const p95 = percentile(values),
      baselineP95 = percentile(previousValues);
    if (rows[0].dataSource === 'memory-cache') assert.ok(p95 <= 200, `${key} 缓存回访P95超过200ms`);
    assert.ok(p95 <= baselineP95 * 1.1, `${key} 内容首帧P95回退超过10%`);
    const feedback = rows.map((row) => row.feedbackMs);
    assert.ok(
      feedback.every((value) => Number.isFinite(value) && value >= 0),
      '缺少交互反馈耗时'
    );
    assert.ok(percentile(feedback) <= 200, `${key} 交互反馈P95超过200ms`);
    const measurements = rows.flatMap((row) => row.tableMeasurements ?? []);
    assert.ok(
      measurements.length &&
        measurements.every((value) => Number.isFinite(value) && value >= 0 && value <= 50),
      `${key} 缺少表格测量或存在超过50ms的测量`
    );
    results.push({ key, samples: rows.length, p95, baselineP95 });
  }
  assert.ok(results.length, '没有可验收的样本');
  assert.equal(results.length, previous.size, '前后路由覆盖不一致');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , currentPath, baselinePath] = process.argv;
  assert.ok(
    currentPath && baselinePath,
    '用法：node scripts/compare-v2-interaction-metrics.mjs 当前报告.json 基线报告.json'
  );
  console.log(
    JSON.stringify(
      compareInteractionMetrics(
        JSON.parse(readFileSync(currentPath, 'utf8')),
        JSON.parse(readFileSync(baselinePath, 'utf8'))
      ),
      null,
      2
    )
  );
}
