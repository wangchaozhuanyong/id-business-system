import { Body, Controller, Delete, Get, Header, Param, Post, Put, Req } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2TotpAccountDto,
  UpdateIdBusinessV2TotpAccountDto
} from './dto/id-business-v2-totp-account.dto';
import { IdBusinessV2TotpAccountService } from './id-business-v2-totp-account.service';

@Controller('id-business-v2/workspace-totp-accounts')
export class IdBusinessV2TotpAccountController {
  constructor(private readonly service: IdBusinessV2TotpAccountService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.list(operator);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  create(
    @Body() dto: CreateIdBusinessV2TotpAccountDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.create(dto, operator, request?.requestId);
  }

  @Put(':accountId')
  @Header('Cache-Control', 'private, no-store')
  update(
    @Param('accountId') accountId: string,
    @Body() dto: UpdateIdBusinessV2TotpAccountDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.update(accountId, dto, operator, request?.requestId);
  }

  @Delete(':accountId')
  remove(
    @Param('accountId') accountId: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.remove(accountId, operator, request?.requestId);
  }
}
