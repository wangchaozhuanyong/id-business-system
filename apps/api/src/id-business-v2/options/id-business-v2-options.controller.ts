import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2OptionDto } from './dto/create-id-business-v2-option.dto';
import type { UpdateIdBusinessV2OptionDto } from './dto/update-id-business-v2-option.dto';
import { IdBusinessV2OptionsService } from './id-business-v2-options.service';

@Controller('id-business-v2/options')
@RequirePermissions('data.dictionary.manage')
export class IdBusinessV2OptionsController {
  constructor(private readonly optionsService: IdBusinessV2OptionsService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('parentId') parentId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.optionsService.list({
      page,
      pageSize,
      keyword,
      type,
      status,
      parentId,
      sortBy,
      sortOrder
    });
  }

  @Get('bootstrap')
  async bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('parentId') parentId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    const [types, list, listsByType] = await Promise.all([
      this.optionsService.listTypes(),
      this.optionsService.list({
        page,
        pageSize,
        keyword,
        type,
        status,
        parentId,
        sortBy,
        sortOrder
      }),
      this.optionsService.listDefaultPages()
    ]);
    return {
      types,
      list,
      listsByType,
      generatedAt: new Date().toISOString()
    };
  }

  @Get('types')
  listTypes() {
    return this.optionsService.listTypes();
  }

  @Get('selectors')
  @RequirePermissions()
  listSelectors(
    @Query('type') type?: string,
    @Query('parentId') parentId?: string,
    @Query('includeDisabled') includeDisabled?: string
  ) {
    return this.optionsService.listSelectors(type, parentId, includeDisabled);
  }

  @Get('business-tree')
  @RequirePermissions()
  getBusinessTree() {
    return this.optionsService.getBusinessTree();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.optionsService.get(id);
  }

  @Post()
  create(
    @Body() dto: CreateIdBusinessV2OptionDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.optionsService.create(dto, operator, { requestId: request?.requestId });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2OptionDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.optionsService.update(id, dto, operator, { requestId: request?.requestId });
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.optionsService.remove(id, operator, { requestId: request?.requestId });
  }
}
