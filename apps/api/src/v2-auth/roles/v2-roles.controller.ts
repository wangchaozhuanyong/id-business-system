import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateV2RoleDto, ListV2RolesQuery, UpdateV2RoleDto } from './v2-roles.dto';
import { V2RolesService } from './v2-roles.service';

@Controller('v2/roles')
@RequireRoles('admin')
export class V2RolesController {
  constructor(private readonly rolesService: V2RolesService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.rolesService.list({
      page,
      pageSize,
      keyword,
      sortBy,
      sortOrder
    });
  }

  @Get('bootstrap')
  bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    const query: ListV2RolesQuery = {
      page,
      pageSize,
      keyword,
      sortBy,
      sortOrder
    };
    return this.rolesService.bootstrap(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.rolesService.get(id);
  }

  @Post()
  create(@Body() dto: CreateV2RoleDto, @CurrentUser() operator: AuthenticatedUser) {
    return this.rolesService.create(dto, operator);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateV2RoleDto,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.rolesService.update(id, dto, operator);
  }
}
