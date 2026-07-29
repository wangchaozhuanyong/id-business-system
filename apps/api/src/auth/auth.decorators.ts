import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

interface RequestWithUser {
  user?: AuthenticatedUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  }
);
