import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { CurrentUser, Public, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { UpdateIdBusinessV2BrandingSettingsDto } from './dto/update-id-business-v2-branding-settings.dto';
import { IdBusinessV2BrandingService } from './id-business-v2-branding.service';

@Controller('id-business-v2/branding')
export class IdBusinessV2BrandingController {
  constructor(private readonly brandingService: IdBusinessV2BrandingService) {}

  @Get('public')
  @Public()
  getPublicSettings() {
    return this.brandingService.get();
  }

  @Get()
  @RequireRoles('admin')
  getSettings() {
    return this.brandingService.get();
  }

  @Patch()
  @RequireRoles('admin')
  updateSettings(
    @Body() dto: UpdateIdBusinessV2BrandingSettingsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.brandingService.update(dto, operator, request?.requestId);
  }
}
