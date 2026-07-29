import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap } from 'rxjs';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditLogsService } from './audit-logs.service';
import { SENSITIVE_ACTION_KEY, type SensitiveActionOptions } from './sensitive-action.decorator';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Injectable()
export class SensitiveActionAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogsService: AuditLogsService
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const options = this.reflector.getAllAndOverride<SensitiveActionOptions>(SENSITIVE_ACTION_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    return next.handle().pipe(
      tap((data: unknown) => {
        void this.auditLogsService.create({
          userId: request.user?.id,
          module: options.module,
          action: options.action,
          objectType: options.objectType,
          objectId: options.getObjectId?.(data),
          remark: 'Sensitive action executed'
        });
      })
    );
  }
}
