export const AUTO_REGISTRATION_WORKSPACE_PATH = '/api/id-business-v2/auto-registration/workspace/';

export interface AutoRegistrationStatus {
  ready: boolean;
  workspacePath: string;
  version: string;
  sourceCommit: string;
}

export interface AutoRegistrationWorkspaceSession {
  expiresAt: string;
}

export const autoRegistrationPages = [
  { path: '/', title: '注册控制台' },
  { path: '/accounts', title: '账号管理' },
  { path: '/email-services', title: '邮箱服务' },
  { path: '/payment', title: '订阅管理' },
  { path: '/settings', title: '系统设置' }
] as const;

export type AutoRegistrationPage = (typeof autoRegistrationPages)[number]['path'];
export type AutoRegistrationDraft = Record<string, string | boolean>;

export type AutoRegistrationChildMessage =
  | { type: 'id-registration:ready'; page: AutoRegistrationPage }
  | { type: 'id-registration:draft'; page: AutoRegistrationPage; values: unknown };

export interface AutoRegistrationParentState {
  type: 'id-registration:state';
  theme: 'light' | 'dark';
  tokens: Record<string, string>;
  draft: AutoRegistrationDraft;
}
