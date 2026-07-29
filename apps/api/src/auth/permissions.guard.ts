import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from './auth.types';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './auth.decorators';

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

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!requiredPermissions?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Permission check requires authenticated user');
    }

    if (user.roles.includes('admin')) {
      return true;
    }

    const permissionSet = new Set(user.permissions);
    const allowed = requiredPermissions.every((permission) => permissionSet.has(permission));

    if (!allowed) {
      throw new ForbiddenException('Permission denied');
    }

    return true;
  }
}
