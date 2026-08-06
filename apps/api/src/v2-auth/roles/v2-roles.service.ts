import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2IdentityService } from '../v2-identity.service';
import type { CreateV2RoleDto, ListV2RolesQuery, UpdateV2RoleDto } from './v2-roles.dto';

const ROLE_SORT_FIELDS: Record<string, keyof Prisma.RoleOrderByWithRelationInput> = {
  name: 'name',
  code: 'code',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

const PERMISSION_SELECT = {
  id: true,
  name: true,
  code: true,
  module: true,
  action: true
} satisfies Prisma.PermissionSelect;

const PERMISSION_ORDER_BY = [
  { module: 'asc' as const },
  { action: 'asc' as const },
  { code: 'asc' as const }
] satisfies Prisma.PermissionOrderByWithRelationInput[];

const ROLE_LIST_INCLUDE = {
  rolePermissions: {
    include: {
      permission: {
        select: PERMISSION_SELECT
      }
    },
    orderBy: {
      permission: {
        code: 'asc' as const
      }
    }
  },
  _count: {
    select: {
      userRoles: {
        where: {
          user: {
            deletedAt: null
          }
        }
      }
    }
  }
} satisfies Prisma.RoleInclude;

const ROLE_DETAIL_INCLUDE = {
  ...ROLE_LIST_INCLUDE,
  userRoles: {
    where: {
      user: {
        deletedAt: null
      }
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          status: true
        }
      }
    },
    orderBy: {
      user: {
        displayName: 'asc' as const
      }
    }
  }
} satisfies Prisma.RoleInclude;

type RoleListRecord = Prisma.RoleGetPayload<{ include: typeof ROLE_LIST_INCLUDE }>;
type RoleDetailRecord = Prisma.RoleGetPayload<{ include: typeof ROLE_DETAIL_INCLUDE }>;
type PermissionCatalogRecord = Prisma.PermissionGetPayload<{ select: typeof PERMISSION_SELECT }>;

@Injectable()
export class V2RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly identityService: V2IdentityService
  ) {}

  async list(query: ListV2RolesQuery) {
    const [list, permissions] = await Promise.all([
      this.listRoleRecords(query),
      this.listPermissionCatalog()
    ]);
    return {
      ...list,
      items: list.items.map((role) => this.toResponse(role, permissions))
    };
  }

  private async listRoleRecords(query: ListV2RolesQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeOptionalText(query.keyword, '搜索关键词', 100);
    const where: Prisma.RoleWhereInput = {
      OR: keyword
        ? [
            { name: { contains: keyword, mode: 'insensitive' } },
            { code: { contains: keyword, mode: 'insensitive' } },
            { description: { contains: keyword, mode: 'insensitive' } }
          ]
        : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        include: ROLE_LIST_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.role.count({ where })
    ]);

    return {
      items,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async bootstrap(query: ListV2RolesQuery) {
    const [list, permissions] = await Promise.all([
      this.listRoleRecords(query),
      this.listPermissionCatalog()
    ]);
    return {
      list: {
        ...list,
        items: list.items.map((role) => this.toResponse(role, permissions))
      },
      permissions,
      generatedAt: new Date().toISOString()
    };
  }

  async get(idInput: string) {
    const [role, permissions] = await Promise.all([
      this.findRoleOrThrow(idInput),
      this.listPermissionCatalog()
    ]);
    return this.toDetailResponse(role, permissions);
  }

  async create(dto: CreateV2RoleDto, operator: AuthenticatedUser) {
    const name = this.normalizeRequiredText(dto.name, '角色名称', 100);
    const code = this.normalizeCode(dto.code);
    const description = this.normalizeDescription(dto.description);
    const permissions = await this.requirePermissions(dto.permissionIds);
    await this.assertCodeAvailable(code);

    try {
      const role = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.role.create({
          data: {
            name,
            code,
            description,
            rolePermissions: {
              create: permissions.map((permission) => ({
                permissionId: permission.id
              }))
            }
          },
          include: ROLE_DETAIL_INCLUDE
        });
        await this.auditLogsService.create(
          {
            userId: operator.id,
            module: 'roles',
            action: 'role.create',
            objectType: 'role',
            objectId: created.id,
            afterData: this.toAuditData(created),
            remark: `管理员创建角色：${created.name}（${created.code}）`
          },
          transaction
        );
        return created;
      });
      return this.toDetailResponse(role, []);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('角色编码已存在。');
      }
      throw error;
    }
  }

  async update(idInput: string, dto: UpdateV2RoleDto, operator: AuthenticatedUser) {
    const existing = await this.findRoleOrThrow(idInput);
    if (existing.code === 'admin') {
      throw new ForbiddenException('系统管理员角色不可修改。');
    }

    const name =
      dto.name === undefined ? undefined : this.normalizeRequiredText(dto.name, '角色名称', 100);
    const description =
      dto.description === undefined ? undefined : this.normalizeDescription(dto.description);
    const permissions =
      dto.permissionIds === undefined
        ? undefined
        : await this.requirePermissions(dto.permissionIds);
    if (name === undefined && description === undefined && permissions === undefined) {
      throw new BadRequestException('请至少修改一项角色资料。');
    }

    const role = await this.prisma.$transaction(async (transaction) => {
      if (permissions) {
        await transaction.rolePermission.deleteMany({
          where: {
            roleId: existing.id
          }
        });
        await transaction.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: existing.id,
            permissionId: permission.id
          }))
        });
      }
      const updated = await transaction.role.update({
        where: {
          id: existing.id
        },
        data: {
          name,
          description,
          updatedAt: new Date()
        },
        include: ROLE_DETAIL_INCLUDE
      });
      await this.auditLogsService.create(
        {
          userId: operator.id,
          module: 'roles',
          action: 'role.update',
          objectType: 'role',
          objectId: updated.id,
          beforeData: this.toAuditData(existing),
          afterData: this.toAuditData(updated),
          remark: `管理员更新角色：${updated.name}（${updated.code}）`
        },
        transaction
      );
      return updated;
    });

    for (const assignment of existing.userRoles) {
      this.identityService.invalidateAuthenticatedUser(assignment.userId);
    }
    return this.toDetailResponse(role, []);
  }

  private async findRoleOrThrow(idInput: string) {
    const id = this.normalizeUuid(idInput, '角色');
    const role = await this.prisma.role.findUnique({
      where: {
        id
      },
      include: ROLE_DETAIL_INCLUDE
    });
    if (!role) {
      throw new NotFoundException('角色不存在或已删除。');
    }
    return role;
  }

  private listPermissionCatalog() {
    return this.prisma.permission.findMany({
      select: PERMISSION_SELECT,
      orderBy: PERMISSION_ORDER_BY
    });
  }

  private async assertCodeAvailable(code: string) {
    const existing = await this.prisma.role.findFirst({
      where: {
        code: {
          equals: code,
          mode: 'insensitive'
        }
      },
      select: {
        id: true
      }
    });
    if (existing) {
      throw new ConflictException('角色编码已存在。');
    }
  }

  private async requirePermissions(permissionIdsInput: string[] | undefined) {
    const permissionIds = [
      ...new Set(
        (Array.isArray(permissionIdsInput) ? permissionIdsInput : []).map((permissionId) =>
          this.normalizeUuid(permissionId, '权限')
        )
      )
    ];
    if (!permissionIds.length) {
      throw new BadRequestException('请至少选择一项权限。');
    }
    if (permissionIds.length > 200) {
      throw new BadRequestException('角色权限数量不能超过 200 项。');
    }
    const permissions = await this.prisma.permission.findMany({
      where: {
        id: {
          in: permissionIds
        }
      },
      select: {
        id: true,
        code: true
      }
    });
    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('所选权限不存在，请刷新后重试。');
    }
    return permissions;
  }

  private normalizeCode(value: string | undefined) {
    const code = (value ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,99}$/.test(code)) {
      throw new BadRequestException(
        '角色编码需为 3 至 100 位，以小写字母开头，可包含数字、点、下划线或短横线。'
      );
    }
    if (code === 'admin') {
      throw new BadRequestException('admin 为系统保留角色编码。');
    }
    return code;
  }

  private normalizeRequiredText(value: string | undefined, label: string, maxLength: number) {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException(`请填写${label}。`);
    }
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符。`);
    }
    return normalized;
  }

  private normalizeDescription(value: string | undefined) {
    const normalized = (value ?? '').trim();
    if (normalized.length > 500) {
      throw new BadRequestException('角色说明不能超过 500 个字符。');
    }
    return normalized || null;
  }

  private normalizeOptionalText(value: string | undefined, label: string, maxLength: number) {
    if (value === undefined || value === '') return undefined;
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符。`);
    }
    return normalized || undefined;
  }

  private normalizeUuid(value: string, label: string) {
    const normalized = value.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ) {
      throw new BadRequestException(`${label}不正确。`);
    }
    return normalized;
  }

  private buildOrderBy(query: ListV2RolesQuery): Prisma.RoleOrderByWithRelationInput[] {
    const sortField = query.sortBy ? ROLE_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder =
      query.sortOrder === 'asc' || query.sortOrder === 'desc' ? query.sortOrder : null;
    if (query.sortOrder && !sortOrder) {
      throw new BadRequestException('排序方向不正确。');
    }
    if (!sortField || !sortOrder) {
      return [{ code: 'asc' }];
    }
    return [{ [sortField]: sortOrder }, { code: 'asc' }];
  }

  private toResponse(
    role: RoleListRecord | RoleDetailRecord,
    allPermissions: PermissionCatalogRecord[]
  ) {
    const permissions =
      role.code === 'admin' && allPermissions.length
        ? allPermissions
        : role.rolePermissions.map(({ permission }) => permission);
    return {
      id: role.id,
      name: role.name,
      code: role.code,
      description: role.description,
      isSystemRole: role.code === 'admin',
      permissions,
      permissionIds: permissions.map((permission) => permission.id),
      permissionCount: permissions.length,
      memberCount: role._count.userRoles,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString()
    };
  }

  private toDetailResponse(role: RoleDetailRecord, allPermissions: PermissionCatalogRecord[]) {
    return {
      ...this.toResponse(role, allPermissions),
      members: role.userRoles.map(({ user }) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        status: user.status
      }))
    };
  }

  private toAuditData(role: RoleDetailRecord) {
    return {
      id: role.id,
      name: role.name,
      code: role.code,
      description: role.description,
      permissionCodes: role.rolePermissions.map(({ permission }) => permission.code).sort(),
      memberCount: role._count.userRoles
    };
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
