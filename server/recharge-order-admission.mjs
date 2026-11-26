export const rechargeAdmissionPending = '充值码与成功任务的关联待核对';
export const rechargeAdmissionConflict = '同一充值码存在多个成功任务，请核对';
export const rechargeEvidenceConflict = '成功回执的套餐或账号资料存在冲突，请核对';

export function checkoutDebugCode(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === '[checkout-debug]';
}

export function rechargeCodeKey(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  return /^[^\x00-\x1f\x7f]{1,32}$/u.test(code) && !checkoutDebugCode(code) &&
    !/^ADMIN_PRODUCT_GEN:/i.test(code) ? code.toUpperCase() : '';
}

export async function readRechargeAdmission(task, codes, client) {
  const key = rechargeCodeKey(task.cdk);
  if (!key || task.status !== 'success' || task.progress !== 100) return { needs: rechargeAdmissionPending };
  const matches = codes.filter(row => rechargeCodeKey(row?.code) === key);
  if (matches.length !== 1 || matches[0].type !== '自助' || matches[0].status !== 'used')
    return { needs: rechargeAdmissionPending };

  // The pool identifies the latest session. Check earlier sessions too before
  // admitting the latest one, which could otherwise mask a duplicate success.
  const code = matches[0];
  const successes = new Set();
  const limit = 100;
  const search = encodeURIComponent(code.code);
  for (let offset = 0; offset < 3 * limit; offset += limit) {
    const result = await client.get('/api/admin/sessions?limit=' + limit + '&offset=' + offset + '&search=' + search);
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < offset + result.items.length ||
        result.items.length !== Math.min(limit, result.total - offset)) throw new Error('代充码任务列表格式不正确');
    for (const row of result.items) {
      if (row?.status === 'success' && rechargeCodeKey(row.cdk_code) === key) successes.add(row.job_key);
    }
    if (successes.size > 1 || (successes.size === 1 && !successes.has(task.jobKey)))
      return { needs: rechargeAdmissionConflict };
    if (offset + result.items.length === result.total) {
      if (successes.has(task.jobKey) && code.session_job_key === task.jobKey) return { code };
      break;
    }
  }
  return { needs: rechargeAdmissionPending };
}
