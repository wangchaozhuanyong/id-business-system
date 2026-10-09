'use strict';
async function check(env = process.env) {
  const key = env.ONLINE_RECHARGE_WORKER_KEY;
  const target = new URL('/health', env.ONLINE_RECHARGE_CREDENTIALS_URL || 'http://127.0.0.1:8053');
  if (
    !key ||
    key.length < 32 ||
    target.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error('执行器健康配置无效');
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-online-recharge-worker': key },
    body: '{}',
    signal: AbortSignal.timeout(3000),
    redirect: 'error'
  });
  const value = await response.json();
  if (!response.ok || value.ok !== true || value.ready !== true) throw new Error('执行器尚未就绪');
  return value;
}
if (require.main === module)
  check().catch(() => {
    process.stderr.write('执行器健康检查未通过。\n');
    process.exitCode = 1;
  });
module.exports = { check };
