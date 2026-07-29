export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: string[];
}

export interface JwtPayload {
  sub: string;
  username: string;
  jti: string;
}
