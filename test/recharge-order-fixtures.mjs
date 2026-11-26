export function applyRechargeFixture(store, input) {
  const code = input.order.rechargeCode || 'fixture-' + input.order.taskId;
  return store.applyRechargeOrder({
    ...input,
    order: { ...input.order, rechargeCode: code },
    admission: { code, type: '自助', status: 'used', session_job_key: input.row.jobKey }
  });
}

export function usedRechargeCode(task, plan = 'plus') {
  return { code: task.cdk, type: '自助', status: 'used', session_job_key: task.jobKey, plan_type: plan };
}

export function rechargeSessions(tasks) {
  return { total: tasks.length, items: tasks.map(task => ({
    job_key: task.jobKey, cdk_code: task.cdk, status: task.status, progress: task.progress
  })) };
}
