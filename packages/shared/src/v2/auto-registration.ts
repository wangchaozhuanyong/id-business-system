export const V2_ACCOUNT_OFFERS = [
  'unknown',
  'free_trial',
  'half_price',
  'full_price',
  'other'
] as const;
export type V2AccountOffer = (typeof V2_ACCOUNT_OFFERS)[number];
export const V2_ACCOUNT_OFFER_LABELS: Record<V2AccountOffer, string> = {
  unknown: '待核实',
  free_trial: '0元购',
  half_price: '半价号',
  full_price: '全折扣号',
  other: '其他优惠'
};
export const V2_REGISTRATION_STEPS = [
  'queued',
  'email',
  'email_code',
  'profile',
  'registered',
  'password',
  'password_verified',
  'mfa',
  'mfa_verified',
  'offer',
  'completed'
] as const;
export type V2RegistrationStep = (typeof V2_REGISTRATION_STEPS)[number];
export type V2RegistrationState =
  | 'queued'
  | 'running'
  | 'awaiting_email'
  | 'awaiting_user'
  | 'partial'
  | 'completed'
  | 'cancelled';
export interface V2RegistrationName {
  id: string;
  displayName: string;
  active: boolean;
  usageCount: number;
  updatedAt: string;
}
export interface V2RegistrationJob {
  id: string;
  emailMasked: string;
  displayName: string;
  state: V2RegistrationState;
  step: V2RegistrationStep;
  registered: boolean;
  passwordVerified: boolean;
  mfaVerified: boolean;
  offerStatus: V2AccountOffer;
  reason: string | null;
  browserProfileId: string | null;
  accountId: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}
export interface V2RegistrationStart {
  mailboxAliasId: string;
  proxyId: string;
  nameId?: string;
  birthDate: string;
  confirmIdentity: boolean;
}
export interface V2RegistrationPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const V2_REGISTRATION_STEP_LABELS: Record<V2RegistrationStep, string> = {
  queued: '准备注册',
  email: '填写邮箱',
  email_code: '验证邮箱',
  profile: '填写资料',
  registered: '注册已核实',
  password: '设置密码',
  password_verified: '密码已核实',
  mfa: '设置双重验证',
  mfa_verified: '双重验证已核实',
  offer: '核实优惠',
  completed: '流程结束'
};
