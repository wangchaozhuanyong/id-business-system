import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2ActivationsService } from './id-business-v2-activations.service';

@Controller('id-business-v2/activations')
@RequirePermissions('apple.activation.view')
export class IdBusinessV2ActivationsController {
  constructor(private readonly activationsService: IdBusinessV2ActivationsService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
    @Query('dueStatus') dueStatus?: string,
    @Query('openedFrom') openedFrom?: string,
    @Query('openedTo') openedTo?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.activationsService.list(
      {
        page,
        pageSize,
        keyword,
        customerId,
        serviceOptionId,
        accountId,
        status,
        dueStatus,
        openedFrom,
        openedTo,
        dueFrom,
        dueTo,
        sortBy,
        sortOrder
      },
      operator
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.activationsService.get(id, operator);
  }
}
