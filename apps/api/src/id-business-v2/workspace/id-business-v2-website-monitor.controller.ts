import { Body, Controller, Header, Post } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CheckIdBusinessV2WebsiteDto } from './dto/id-business-v2-website-monitor.dto';
import { IdBusinessV2WebsiteMonitorService } from './id-business-v2-website-monitor.service';

@Controller('id-business-v2/workspace-website-monitor')
export class IdBusinessV2WebsiteMonitorController {
  constructor(private readonly service: IdBusinessV2WebsiteMonitorService) {}

  @Post('check')
  @Header('Cache-Control', 'private, no-store')
  check(@Body() dto: CheckIdBusinessV2WebsiteDto, @CurrentUser() operator?: AuthenticatedUser) {
    return this.service.check(dto, operator);
  }
}
