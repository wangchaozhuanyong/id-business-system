import type {
  AppleMailboxRegistrationStatus,
  AppleMailboxTaskStatus,
  AppleMailboxRow,
  AppleMailboxMarkInput
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
    interrupted: '中断待核对'
  }[value];
}

export function appleMailboxSourceLabel(source: AppleMailboxRow['source']) {
  return source === 'manual' ? '人工标记' : source === 'automatic' ? '注册任务' : '未标记';
}

export function appleMailboxIpSourceLabel(source: AppleMailboxRow['registrationIpSource']) {
  return source === 'observed' ? '任务检测出口' : source === 'manual' ? '人工填写' : '来源未记录';
}

export function appleMailboxTaskActive(status: AppleMailboxTaskStatus | null) {
  return status === 'pending' || status === 'running';
}

export function appleMailboxRegisterReason(row: AppleMailboxRow) {
  if (appleMailboxTaskActive(row.taskStatus)) return '该邮箱已有执行中的任务';
  if (row.taskStatus === 'interrupted') return '请先核对中断任务并解除占用';
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
