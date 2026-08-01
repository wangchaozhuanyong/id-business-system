import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { authHttpError } from '../common/errors/api-http.exception';
import type { AuthenticatedUser } from './auth.types';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, REQUIRED_ROLES_KEY } from './auth.decorators';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!requiredRoles?.length && !requiredPermissions?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw authHttpError(HttpStatus.FORBIDDEN, 'AUTH_PERMISSION_DENIED', '权限校验缺少登录身份。');
    }

    if (
      requiredRoles?.length &&
      !requiredRoles.some((requiredRole) => user.roles.includes(requiredRole))
    ) {
      throw authHttpError(
        HttpStatus.FORBIDDEN,
        'AUTH_PERMISSION_DENIED',
        '当前角色没有权限访问该功能。'
      );
    }

    if (!requiredPermissions?.length) {
      return true;
    }

    if (user.roles.includes('admin')) {
      return true;
    }

    const permissionSet = new Set(user.permissions);
    const allowed = requiredPermissions.every((permission) => permissionSet.has(permission));

    if (!allowed) {
      throw authHttpError(
        HttpStatus.FORBIDDEN,
        'AUTH_PERMISSION_DENIED',
        '没有权限操作，请联系管理员检查角色权限。'
      );
    }

    return true;
  }
}
