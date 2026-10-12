import type {
  AppleMailboxRegistrationStatus,
  AppleMailboxTaskStatus,
  AppleMailboxRow,
  AppleMailboxMarkInput,
  AppleMailboxSyncStatus,
  AppleMailboxRecord
} from './contracts';

export const appleMailboxStatusOptions: Array<{
  value: AppleMailboxRegistrationStatus;
  label: string;
}> = [
  { value: 'unknown', label: '待确认' },
  { value: 'unregistered', label: '未注册' },
  { value: 'registered', label: '已注册' }
];

export function appleMailboxStatusLabel(value: AppleMailboxRegistrationStatus) {
  return appleMailboxStatusOptions.find((option) => option.value === value)?.label ?? '待确认';
}

export function appleMailboxTaskLabel(value: AppleMailboxTaskStatus | null) {
  if (!value) return '暂无任务';
  return {
    pending: '等待执行',
    running: '正在注册',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '中断待核对',
    awaiting_review: '结果待核对'
  }[value];
}

export function appleMailboxSyncLabel(value?: AppleMailboxSyncStatus) {
  if (!value || value === 'not_ready') return '尚未具备同步条件';
  return {
    not_started: '尚未开始同步',
    awaiting_identity: '等待身份核验',
    blocked: '同步条件未满足',
    quarantined: '迟到结果隔离待核对',
    pending: '等待同步',
    syncing: '正在同步',
    saved: '已同步到 ChatGPT 账号',
    failed: '同步失败，可仅补同步',
    conflict: '账号冲突，等待核对'
  }[value];
}

export function appleMailboxCanSync(value?: AppleMailboxSyncStatus) {
  return value === 'pending' || value === 'failed' || value === 'awaiting_identity';
}

export function appleMailboxCanSaveLocal(
  value: AppleMailboxRecord['localSaveStatus'],
  status: AppleMailboxTaskStatus | null
) {
  return (
    (value === 'pending' || value === 'failed') &&
    status !== null &&
    !appleMailboxTaskActive(status)
  );
}

export function appleMailboxLocalSaveLabel(value: AppleMailboxRecord['localSaveStatus']) {
  return value === 'saved'
    ? '自动注册账号已保存'
    : value === 'failed'
      ? '自动注册账号保存失败'
      : value === 'pending'
        ? '等待保存自动注册账号'
        : '自动注册账号尚未保存';
}

export function appleMailboxIdentityLabel(value: AppleMailboxRecord['identityStatus']) {
  return value === 'verified'
    ? '账号身份已核验'
    : value === 'mismatch'
      ? '账号身份不符，等待核对'
      : '账号身份尚未核验';
}

export function appleMailboxDiagnostic(
  record?: Pick<AppleMailboxRecord, 'stage' | 'reason' | 'syncErrorKind' | 'firstFailure'>
) {
  if (!record) return '';
  const stages: Record<string, string> = {
    queued: '等待执行',
    signup: '提交注册表单',
    verification_code: '邮箱验证码',
    verification_validate: '验证邮箱验证码',
    password: '注册密码提交',
    create_account: '创建官网账号',
    workspace: '读取账号工作区',
    select_workspace: '选择账号工作区',
    redirect: '授权跳转',
    oauth: '注册后授权',
    account_save: '自动注册账号保存',
    identity: '账号身份核验',
    sync: 'ChatGPT 账号同步'
  };
  const reasons: Record<string, string> = {
    account_creation_failed: '官网返回账号创建失败，请核对原任务结果',
    email_conflict: '已有同邮箱账号，来源冲突',
    deleted_account: '关联账号已删除，请核对原记录',
    storage_unavailable: '账号存储暂时不可用',
    sync_failed: '主账号同步失败',
    identity_missing: '缺少可核验的账号身份',
    identity_mismatch: '注册账号与任务邮箱不符',
    local_save_failed: '自动注册本地账号保存失败',
    payload_invalid: '账号保存资料不完整',
    password_missing: '缺少原注册密码，等待核对',
    existing_account_suspected: '官网提示可能已有账号，等待身份核验'
  };
  const reason = record.reason || record.syncErrorKind;
  const current = [
    record.stage ? stages[record.stage] || '注册后处理' : '',
    reason ? reasons[reason] || '执行结果需核对，请查看任务记录' : ''
  ]
    .filter(Boolean)
    .join(' · ');
  const failure = record.firstFailure;
  if (!failure) return current;
  const errors = {
    http_rejected: '服务返回失败',
    network_error: '网络请求异常',
    unknown: '执行结果待核对',
    account_creation_failed: '官网返回账号创建失败',
    user_exists: '官网提示已有账号，需核验身份'
  };
  return [
    `首次失败：${failure.stage === 'queued' ? '注册初始化' : stages[failure.stage] || '执行步骤待核对'} · ${errors[failure.errorKind] || '执行结果待核对'}`,
    failure.httpStatus === null ? '未取得响应状态' : `响应状态 ${failure.httpStatus}`,
    `耗时 ${failure.elapsedMs / 1000} 秒`,
    current ? `当前：${current}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

export function appleMailboxSelectionLabel(
  record?: Pick<AppleMailboxRecord, 'mailboxSelection' | 'proxySource' | 'proxyId'>
) {
  if (!record) return '';
  const selection =
    record.mailboxSelection === 'automatic'
      ? '自动选择邮箱'
      : record.mailboxSelection === 'specified'
        ? '指定邮箱'
        : '';
  const proxy =
    record.proxySource === 'system'
      ? `系统代理${record.proxyId ? `（编号 ${record.proxyId}）` : ''}`
      : record.proxySource === 'explicit'
        ? '手工代理配置'
        : record.proxySource === 'default'
          ? '系统默认代理配置'
          : '';
  return [selection, proxy].filter(Boolean).join(' · ');
}

export function appleMailboxSourceLabel(source: AppleMailboxRow['source']) {
  return source === 'manual'
    ? '人工标记'
    : source === 'automatic'
      ? '注册任务'
      : source === 'account_history'
        ? '历史账号记录'
        : '未标记';
}

export function appleMailboxIpSourceLabel(source: AppleMailboxRow['registrationIpSource']) {
  return source === 'observed' ? '任务检测出口' : source === 'manual' ? '人工填写' : '来源未记录';
}

export function appleMailboxTaskActive(status: AppleMailboxTaskStatus | null) {
  return status === 'pending' || status === 'running';
}

export function appleMailboxNeedsReview(
  row: Pick<AppleMailboxRow, 'activeTaskUuid' | 'taskStatus'>
) {
  // 旧接口未返回占用编号时仍保留保护；已解除占用的历史状态不再阻止人工标记。
  return (
    row.activeTaskUuid !== null &&
    (row.taskStatus === 'interrupted' || row.taskStatus === 'awaiting_review')
  );
}

export function appleMailboxCanRecover(
  row: Pick<AppleMailboxRow, 'taskUuid' | 'activeTaskUuid' | 'taskStatus'>
) {
  return Boolean(row.taskUuid) && appleMailboxNeedsReview(row);
}

export function appleMailboxBusy(row: AppleMailboxRow) {
  return (
    appleMailboxTaskActive(row.taskStatus) ||
    Boolean(row.activeTaskUuid) ||
    appleMailboxNeedsReview(row)
  );
}

export function appleMailboxRegisterReason(row: AppleMailboxRow) {
  if (appleMailboxTaskActive(row.taskStatus)) return '该邮箱已有执行中的任务';
  if (appleMailboxNeedsReview(row)) return '请先查看任务，人工核对后解除占用并标记注册状态';
  if (row.activeTaskUuid) return '邮箱仍被原任务占用，请先核对任务状态';
  if (row.registrationStatus === 'registered') return '该邮箱已注册，不能再次注册';
  if (row.registrationStatus !== 'unregistered') return '请先确认并标记为未注册';
  if (row.mailboxStatus !== 'ACTIVE') return '隐藏邮箱已停用';
  if (!row.primaryAvailable) return '所属主邮箱不可用';
  if (!row.authorizationValid) return '邮箱查询授权已失效';
  return row.canRegister ? '' : row.blockedReason || '当前邮箱暂时不能注册';
}

export function isAppleMailboxIp(value: string) {
  if (!value) return true;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value))
    return value.split('.').every((part) => Number(part) <= 255);
  if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function appleMailboxMarkError(input: AppleMailboxMarkInput) {
  if (!input.items.length) return '请选择需要标记的邮箱';
  if (!appleMailboxStatusOptions.some((item) => item.value === input.registrationStatus))
    return '请选择注册状态';
  if (input.registrationIp && !isAppleMailboxIp(input.registrationIp))
    return '请填写有效的 IPv4 或 IPv6 地址';
  if (input.note.length > 500) return '备注不能超过 500 个字';
  return '';
}
