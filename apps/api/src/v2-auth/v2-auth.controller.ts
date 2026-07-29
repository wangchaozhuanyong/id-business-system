import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Public } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { LoginDto } from '../auth/dto/login.dto';

interface RequestWithMeta {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

@Controller('auth')
export class V2AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() request: RequestWithMeta) {
    return this.authService.login(dto, {
      ip: request.ip,
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
  }

  @Post('logout')
  logout(@Req() request: RequestWithMeta, @CurrentUser() user?: AuthenticatedUser) {
    return this.authService.logout(this.extractBearerToken(request), user);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Post('refresh')
  refresh(@CurrentUser() user: AuthenticatedUser, @Req() request: RequestWithMeta) {
    return this.authService.refresh(user, {
      ip: request.ip,
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
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
