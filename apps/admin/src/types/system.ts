export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  roles: readonly string[];
  permissions: readonly string[];
  mustResetPassword: boolean;
}
