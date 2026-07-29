import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { SupabaseAuthService } from './supabase-auth.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';

interface RequestWithAuthHeader {
  headers: {
    authorization?: string;
  };
  originalUrl?: string;
  query?: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly identityService: V2IdentityService,
    private readonly securityService: SecurityService,
    private readonly supabaseAuthService: SupabaseAuthService
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuthHeader>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('请先登录后再操作。');
    }

    try {
      if (this.supabaseAuthService.isEnabled()) {
        const userId = await this.supabaseAuthService.authenticateAccessToken(token);
        const ipAllowed = await this.securityService.isRequestIpAllowed(request.ip, [
          'admin',
          'api'
        ]);
        if (!ipAllowed) {
          throw new ForbiddenException('当前 IP 不在白名单内，无法访问。');
        }
        request.user = await this.identityService.getAuthenticatedUser(userId);
        return true;
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const active = await this.securityService.isAccessTokenActive(token);
      if (!active) {
        throw new UnauthorizedException('登录状态已过期或已被下线，请重新登录。');
      }

      const ipAllowed = await this.securityService.isRequestIpAllowed(request.ip, ['admin', 'api']);
      if (!ipAllowed) {
        throw new ForbiddenException('当前 IP 不在白名单内，无法访问。');
      }

      request.user = await this.identityService.getAuthenticatedUser(payload.sub);
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new UnauthorizedException('登录状态无效或已过期，请重新登录。');
    }
  }

  private extractToken(request: RequestWithAuthHeader) {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && token) {
      return token;
    }

    if (!request.originalUrl?.startsWith('/api/realtime/events')) {
      return undefined;
    }

    const queryToken = request.query?.accessToken;
    return Array.isArray(queryToken) ? queryToken[0] : queryToken;
  }
}
