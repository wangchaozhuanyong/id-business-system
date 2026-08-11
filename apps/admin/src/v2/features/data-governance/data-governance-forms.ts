import type { FormRules } from 'element-plus';

export interface RestoreFormModel {
  reason: string;
  backupEvidence: string;
}

export interface CleanupFormModel extends RestoreFormModel {
  olderThanDays: number;
}

export interface DecisionFormModel {
  decision: 'approved' | 'rejected';
  reason: string;
}

export const RESTORE_INITIAL: RestoreFormModel = { reason: '', backupEvidence: '' };
export const CLEANUP_INITIAL: CleanupFormModel = {
  olderThanDays: 30,
  reason: '',
  backupEvidence: ''
};
export const DECISION_INITIAL: DecisionFormModel = { decision: 'approved', reason: '' };

export const restoreRules: FormRules<RestoreFormModel> = {
  reason: [
    { required: true, message: '请输入申请原因', trigger: 'blur' },
    { min: 8, max: 1_000, message: '申请原因需为 8-1000 个字符', trigger: 'blur' }
  ],
  backupEvidence: [
    { required: true, message: '请输入备份证据', trigger: 'blur' },
    { min: 8, max: 2_000, message: '备份证据需为 8-2000 个字符', trigger: 'blur' }
  ]
};
export const cleanupRules: FormRules<CleanupFormModel> = {
  olderThanDays: [{ required: true, message: '请输入保留天数', trigger: 'change' }],
  ...restoreRules
};
export const decisionRules: FormRules<DecisionFormModel> = {
  decision: [{ required: true, message: '请选择审批决定', trigger: 'change' }],
  reason: [
    { required: true, message: '请输入审批意见', trigger: 'blur' },
    { min: 4, max: 1_000, message: '审批意见需为 4-1000 个字符', trigger: 'blur' }
  ]
};

export function createGovernanceMutationKey(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}:${suffix}`;
}
