import { Body, Controller, Delete, Get, Header, Param, Post, Put, Req } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  IdBusinessV2QuickActionDto,
  ReorderIdBusinessV2QuickActionsDto
} from './dto/id-business-v2-quick-action.dto';
import { IdBusinessV2QuickActionService } from './id-business-v2-quick-action.service';

@Controller('id-business-v2/quick-actions')
export class IdBusinessV2QuickActionController {
  constructor(private readonly service: IdBusinessV2QuickActionService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.list(operator);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  create(
    @Body() dto: IdBusinessV2QuickActionDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.create(dto, operator, request?.requestId);
  }

  @Put('order')
  @Header('Cache-Control', 'private, no-store')
  reorder(
    @Body() dto: ReorderIdBusinessV2QuickActionsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.reorder(dto, operator, request?.requestId);
  }

  @Put(':id')
  @Header('Cache-Control', 'private, no-store')
  update(
    @Param('id') id: string,
    @Body() dto: IdBusinessV2QuickActionDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.update(id, dto, operator, request?.requestId);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.remove(id, operator, request?.requestId);
  }
}
