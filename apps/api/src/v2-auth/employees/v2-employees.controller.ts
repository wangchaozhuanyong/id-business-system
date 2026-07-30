import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateV2EmployeeDto,
  ListV2EmployeesQuery,
  UpdateV2EmployeeDto
} from './v2-employees.dto';
import { V2EmployeesService } from './v2-employees.service';

@Controller('v2/employees')
@RequireRoles('admin')
export class V2EmployeesController {
  constructor(private readonly employeesService: V2EmployeesService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('roleId') roleId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.employeesService.list({
      page,
      pageSize,
      keyword,
      status,
      roleId,
      sortBy,
      sortOrder
    });
  }

  @Get('bootstrap')
  bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('roleId') roleId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    const query: ListV2EmployeesQuery = {
      page,
      pageSize,
      keyword,
      status,
      roleId,
      sortBy,
      sortOrder
    };
    return this.employeesService.bootstrap(query);
  }

  @Post()
  create(@Body() dto: CreateV2EmployeeDto, @CurrentUser() operator: AuthenticatedUser) {
    return this.employeesService.create(dto, operator);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateV2EmployeeDto,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.employeesService.update(id, dto, operator);
  }
}
