import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Req
} from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2WorkspaceShortcutDto,
  ReorderIdBusinessV2WorkspaceShortcutsDto,
  UpdateIdBusinessV2WorkspaceShortcutDto
} from './dto/id-business-v2-workspace-shortcut.dto';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';

@Controller('id-business-v2/workspace-shortcuts')
export class IdBusinessV2WorkspaceController {
  constructor(private readonly service: IdBusinessV2WorkspaceService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.list(operator);
  }

  @Post()
  create(
    @Body() dto: CreateIdBusinessV2WorkspaceShortcutDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.create(dto, operator, request?.requestId);
  }

  @Patch(':shortcutId')
  update(
    @Param('shortcutId') shortcutId: string,
    @Body() dto: UpdateIdBusinessV2WorkspaceShortcutDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.update(shortcutId, dto, operator, request?.requestId);
  }

  @Delete(':shortcutId')
  remove(
    @Param('shortcutId') shortcutId: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.remove(shortcutId, operator, request?.requestId);
  }

  @Put('order')
  reorder(
    @Body() dto: ReorderIdBusinessV2WorkspaceShortcutsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.reorder(dto, operator, request?.requestId);
  }
}
