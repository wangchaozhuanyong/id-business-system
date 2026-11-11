import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';

const jobKey = '1794150000000-fixture';
const submitted = '[Stripe] ✅ 已点击提交按钮 (role=Subscribe)';
const billingError = "❌ [运行时错误]: MySQL 执行失败: Data too long for column 'error_message' at row 1";
const review = '已点击付款，失败记录保存异常；付款结果待核实';
let taskDetailScript;

before(async () => {
  const assets = await loadCodexdaichongAssets();
  const source = String(assets.get('/admin.js').body);
  new Script(source);
  const start = source.indexOf('        function formatTaskDetailJson(');
  const end = source.indexOf('        function showMessage(', start);
  assert.ok(start >= 0 && end > start);
  taskDetailScript = source.slice(start, end);
});

async function openTaskDetail(task, runtimeEntries = []) {
  const body = { innerHTML: '' };
  const meta = { textContent: '' };
  const requests = [];
  const nodes = {
    task_log_modal_body: body,
    task_log_modal_meta: meta,
    task_log_modal_overlay: { classList: { add() {} } }
  };
  await runInNewContext(taskDetailScript + '\nopenTaskLogModal(jobKey);', {
    jobKey,
    document: { getElementById: id => nodes[id] },
    closeTaskLogModal() {},
    async authFetch(path, options) {
      requests.push({ path, method: options?.method ?? 'GET' });
      return { ok: true };
    },
    async readJsonResponse() {
      return { ok: true, data: { success: true, task: { jobKey, progress: 80, ...task }, runtimeEntries } };
    },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  });
  assert.deepEqual(requests, [{ path: '/integrations/codexdaichong/api/admin/task-logs/' + jobKey, method: 'GET' }]);
  return { body: body.innerHTML, meta: meta.textContent };
}

test('admin detail shows only a fixed review message and task number after the identified billing write error', async () => {
  const result = await openTaskDetail({
    status: 'failed',
    message: 'private-message-fixture',
    rawOutput: ['===== ATTEMPT 1 =====', submitted, 'private-raw-output-fixture', billingError].join('\r\n'),
    cdk: 'private-cdk-fixture',
    gptApiRaw: '{"targetEmail":"private-account-fixture@example.test"}'
  }, [{ text: 'private-runtime-entry-fixture' }]);
  assert.ok(result.body.includes(review));
  assert.ok(result.body.includes(jobKey));
  assert.ok(result.meta.includes(jobKey));
  assert.doesNotMatch(result.body, /private-|Data too long|error_message/);
});

test('admin detail retains its existing presentation when the final attempt lacks the exact evidence', async () => {
  for (const [status, rawOutput] of [
    ['failed', billingError],
    ['failed', `${submitted}\n${billingError.replace('error_message', 'message')}`],
    ['failed', `${billingError}\n${submitted}`],
    ['failed', `===== ATTEMPT 1 =====\n${submitted}\n===== ATTEMPT 2 =====\n${billingError}`],
    ['success', `${submitted}\n${billingError}`]
  ]) {
    const result = await openTaskDetail({ status, rawOutput, message: '原任务详情' });
    assert.ok(result.body.includes('原任务详情'));
    assert.ok(!result.body.includes(review));
  }
});
