import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermissions } from '../../auth/auth.decorators';
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
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.activationsService.list({
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
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.activationsService.get(id);
  }
}
