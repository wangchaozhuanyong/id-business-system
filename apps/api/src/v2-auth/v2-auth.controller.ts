import { Body, Controller, Get, Header, Post, Req, Res } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AllowDuringPasswordReset, CurrentUser, Public } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { ChangePasswordDto } from '../auth/dto/change-password.dto';
import type { LoginDto } from '../auth/dto/login.dto';
import { resolveTrustedClientIp } from '../common/http/trusted-client-ip';
import {
  readBrowserSessionToken,
  setBrowserSessionCookie,
  type BrowserSessionRequest,
  type BrowserSessionResponse
} from '../auth/browser-session-cookie';

interface RequestWithMeta extends BrowserSessionRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

@Controller('auth')
export class V2AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() dto: LoginDto,
    @Req() request: RequestWithMeta,
    @Res({ passthrough: true }) response: BrowserSessionResponse
  ) {
    const result = await this.authService.login(dto, {
      ip: resolveTrustedClientIp(request),
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
    this.rememberBrowserSession(request, response, result.accessToken);
    return result;
  }

  @Post('logout')
  @AllowDuringPasswordReset()
  async logout(
    @Req() request: RequestWithMeta,
    @Res({ passthrough: true }) response: BrowserSessionResponse,
    @CurrentUser() user?: AuthenticatedUser
  ) {
    try {
      return await this.authService.logout(this.extractBearerToken(request), user);
    } finally {
      setBrowserSessionCookie(response, null);
    }
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @AllowDuringPasswordReset()
  me(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithMeta,
    @Res({ passthrough: true }) response: BrowserSessionResponse
  ) {
    this.rememberBrowserSession(request, response, this.extractBearerToken(request));
    return user;
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  @AllowDuringPasswordReset()
  session(@CurrentUser() user: AuthenticatedUser, @Req() request: RequestWithMeta) {
    return {
      accessToken: this.extractBearerToken(request) ?? readBrowserSessionToken(request),
      user
    };
  }

  @Post('refresh')
  @Header('Cache-Control', 'no-store')
  async refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithMeta,
    @Res({ passthrough: true }) response: BrowserSessionResponse
  ) {
    const result = await this.authService.refresh(user, {
      ip: resolveTrustedClientIp(request),
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
    this.rememberBrowserSession(request, response, result.accessToken);
    return result;
  }

  @Post('change-password')
  @AllowDuringPasswordReset()
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() request: RequestWithMeta,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: BrowserSessionResponse
  ) {
    const result = await this.authService.changePassword(
      dto,
      this.extractBearerToken(request),
      user
    );
    setBrowserSessionCookie(response, null);
    return result;
  }

  private rememberBrowserSession(
    request: RequestWithMeta,
    response: BrowserSessionResponse,
    token?: string
  ) {
    if (token && request.headers['sec-fetch-site'] === 'same-origin') {
      setBrowserSessionCookie(response, token);
    }
  }

  private getHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value.join(', ') : value;
  }

  private extractBearerToken(request: RequestWithMeta) {
    const authorization = this.getHeaderValue(request.headers.authorization);
    const [type, token] = authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
