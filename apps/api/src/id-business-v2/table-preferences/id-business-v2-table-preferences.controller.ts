import { Body, Controller, Delete, Get, Header, Param, Put, Req } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { UpdateIdBusinessV2TablePreferenceDto } from './dto/update-id-business-v2-table-preference.dto';
import { IdBusinessV2TablePreferencesService } from './id-business-v2-table-preferences.service';

@Controller('id-business-v2/table-preferences')
export class IdBusinessV2TablePreferencesController {
  constructor(private readonly service: IdBusinessV2TablePreferencesService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.list(operator);
  }

  @Put(':tableId')
  update(
    @Param('tableId') tableId: string,
    @Body() dto: UpdateIdBusinessV2TablePreferenceDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.update(tableId, dto, operator, request?.requestId);
  }

  @Delete(':tableId')
  reset(
    @Param('tableId') tableId: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.reset(tableId, operator, request?.requestId);
  }
}
