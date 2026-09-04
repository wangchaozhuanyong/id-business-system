import { Body, Controller, Delete, Get, Header, Patch, Post, Put, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  SaveIdBusinessV2GoogleSheetsSyncConfigDto,
  UpdateIdBusinessV2GoogleSheetsSyncStateDto
} from './dto/id-business-v2-google-sheets-sync.dto';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import { IdBusinessV2GoogleSheetsSyncWorker } from './id-business-v2-google-sheets-sync.worker';

@RequireRoles('admin')
@Controller('id-business-v2/google-sheets-sync')
export class IdBusinessV2GoogleSheetsSyncController {
  constructor(
    private readonly service: IdBusinessV2GoogleSheetsSyncService,
    private readonly worker: IdBusinessV2GoogleSheetsSyncWorker
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  status(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.getStatus(operator);
  }

  @Put('config')
  @Header('Cache-Control', 'private, no-store')
  saveConfig(
    @Body() dto: SaveIdBusinessV2GoogleSheetsSyncConfigDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.saveConfig(dto, operator, request?.requestId);
  }

  @Post('authorizations')
  @Header('Cache-Control', 'private, no-store')
  startAuthorization(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.startAuthorization(operator);
  }

  @Patch('state')
  @Header('Cache-Control', 'private, no-store')
  updateState(
    @Body() dto: UpdateIdBusinessV2GoogleSheetsSyncStateDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updateState(dto, operator, request?.requestId);
  }

  @Post('runs')
  @Header('Cache-Control', 'private, no-store')
  run(@CurrentUser() operator?: AuthenticatedUser, @Req() request?: { requestId?: string }) {
    return this.worker.runNow(true, operator, request?.requestId);
  }

  @Delete('connection')
  @Header('Cache-Control', 'private, no-store')
  disconnect(@CurrentUser() operator?: AuthenticatedUser, @Req() request?: { requestId?: string }) {
    return this.service.disconnect(operator, request?.requestId);
  }
}
