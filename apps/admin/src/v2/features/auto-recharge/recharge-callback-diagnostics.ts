import type { V2RechargeJob } from './contracts';

const operationLabels: Record<string, string> = {
  restore: '恢复原账号与结算资料',
  progress: '保存执行进度',
  ledger: '保存原单安全记录',
  finished: '保存任务结束回执',
  prepare_next_subscription_cycle: '核实旧订阅周期',
  resolve_unknown_payment: '核实原单付款处理结果',
  stale_profile_cleanup: '登记历史窗口清理结果'
};
const phaseLabels: Record<string, string> = {
  inspect: '只读核实',
  status: '读取核实状态',
  commit: '登记新周期资格'
};
const failureLabels: Record<string, string> = {
  http: '服务器未受理回传',
  timeout: '回传等待超时',
  transport: '回传连接未确认',
  invalid_response: '回传响应格式未确认'
};
const errorLabels: Record<string, string> = {
  BAD_REQUEST: '请求资料校验未通过',
  VALIDATION_ERROR: '请求资料校验未通过',
  AUTH_INVALID: '任务访问凭据未确认',
  AUTH_PERMISSION_DENIED: '任务操作权限未确认',
  RATE_LIMITED: '回传请求暂时过于频繁',
  UNAUTHORIZED: '任务访问凭据未确认',
  FORBIDDEN: '任务操作权限未确认',
  NOT_FOUND: '任务或原记录未找到',
  CONFLICT: '任务或原记录状态冲突',
  INTERNAL_SERVER_ERROR: '记录服务执行异常',
  SERVICE_UNAVAILABLE: '记录服务暂时不可用',
  REQUEST_TIMEOUT: '记录服务处理超时'
};
const businessLabels: Record<string, string> = {
  callback_original_checkout_missing: '原结算记录缺失',
  callback_original_checkout_unverified: '原结算编号尚未核实',
  callback_original_checkout_mismatch: '原结算绑定不一致',
  callback_original_payment_unverified: '原单付款状态尚未核实',
  callback_account_owned_by_another_operator: '账号归属与当前操作人不一致',
  callback_profile_binding_conflict: '本次任务的原窗口绑定发生冲突',
  callback_original_payment_profile_unverified: '原付款窗口归属尚未核实',
  callback_profile_replacement_conflict: '原窗口更换回执发生冲突'
};

function mapped(labels: Record<string, string>, value: unknown) {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : undefined;
}

export function rechargeCallbackDiagnostics(job: V2RechargeJob) {
  const result = job.result;
  const status = result.callback_http_status;
  const code = result.callback_error_code;
  const requestId = result.callback_request_id;
  return {
    operation: mapped(operationLabels, result.callback_operation),
    phase: mapped(phaseLabels, result.callback_phase),
    failureKind: mapped(failureLabels, result.callback_failure_kind),
    httpStatus:
      typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : undefined,
    errorCode:
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? mapped(errorLabels, code)
        : undefined,
    requestId:
      typeof requestId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(requestId)
        ? requestId
        : undefined,
    businessReason: mapped(businessLabels, result.callback_business_reason)
  };
}

export function rechargeCallbackFailureSummary(job: V2RechargeJob) {
  const diagnostic = rechargeCallbackDiagnostics(job);
  const context = [diagnostic.operation, diagnostic.phase, diagnostic.failureKind].filter(Boolean);
  if (diagnostic.httpStatus) context.push(`回传状态 ${diagnostic.httpStatus}`);
  if (diagnostic.requestId) context.push(`请求编号：${diagnostic.requestId}`);
  return context.length ? `回传记录：${context.join('；')}。` : '';
}
