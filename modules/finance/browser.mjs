import * as finance from './accounting.mjs?v=20261111-expense-accounting';

async function requestAutomaticSnapshot(orderId, version) {
  const response = await window.fetch('/api/local/finance/auto-snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, version })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || '自动汇率服务暂不可用');
    error.status = response.status;
    throw error;
  }
  return data;
}

const enabled = document.querySelector('meta[name="id-finance-auto-quote"]')?.content === 'enabled';
window.IDDesignAPI.modules.commerce.installFinance({
  ...finance,
  requestAutomaticSnapshot: enabled ? requestAutomaticSnapshot : undefined
});
