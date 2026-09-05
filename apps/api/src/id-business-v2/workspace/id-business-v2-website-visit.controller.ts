import { Body, Controller, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, Public, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2WebsiteVisitService } from './id-business-v2-website-visit.service';
import {
  IdBusinessV2WebsiteVisitSignatureGuard,
  type WebsiteVisitRequest
} from './id-business-v2-website-visit-signature.guard';

@Controller('id-business-v2/workspace-website-monitor/visits')
export class IdBusinessV2WebsiteVisitController {
  constructor(private readonly service: IdBusinessV2WebsiteVisitService) {}

  @Post('ingest')
  @Public()
  @UseGuards(IdBusinessV2WebsiteVisitSignatureGuard)
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  ingest(@Req() request: WebsiteVisitRequest) {
    return this.service.ingest(request.websiteVisit!);
  }

  @Post('search')
  @RequireRoles('admin')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  search(@Body() value: unknown, @CurrentUser() operator?: AuthenticatedUser) {
    return this.service.search(value, operator);
  }

  @Post(':id/reveal')
  @RequireRoles('admin')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  reveal(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.service.reveal(id, operator);
  }
}
