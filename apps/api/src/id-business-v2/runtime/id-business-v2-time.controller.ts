import { Controller, Get } from '@nestjs/common';
import { ID_BUSINESS_V2_TIME_ZONE } from './id-business-v2-time';

@Controller('id-business-v2/time')
export class IdBusinessV2TimeController {
  @Get()
  getTime() {
    return {
      now: new Date().toISOString(),
      timezone: ID_BUSINESS_V2_TIME_ZONE
    };
  }
}
