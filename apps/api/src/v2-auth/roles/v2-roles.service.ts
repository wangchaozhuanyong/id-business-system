import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type {
  IdBusinessV2SensitiveDisplayContext,
  IdBusinessV2SensitiveDisplayMode,
  Prisma
} from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { getPagination } from '../../common/pagination';
import { bumpV2ScopeVersions } from '../../common/prisma/bump-v2-scope-versions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SecurityService } from '../../security/security.service';
import { V2IdentityService } from '../v2-identity.service';
import {
  ID_BUSINESS_V2_SENSITIVE_MODE_LABELS,
  ID_BUSINESS_V2_SENSITIVE_PERMISSION_CODES,
  getIdBusinessV2SensitiveAllowedDisplayModes,
  getIdBusinessV2SensitiveDescriptorByKey,
  listIdBusinessV2SensitiveDisplayCatalog
} from '../../id-business-v2/sensitive-access/public-api';
import type {
  CreateV2RoleDto,
  ListV2RolesQuery,
  UpdateV2RoleDto,
  V2SensitiveDisplayPolicyDto
} from './v2-roles.dto';

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

const DEPRECATED_PERMISSION_CODES = new Set(['apple.account.delete']);

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
  sensitiveDisplayPolicies: {
    orderBy: [{ fieldKey: 'asc' as const }, { context: 'asc' as const }]
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
type SensitiveDisplayPolicyInput = {
  fieldKey: string;
  context: IdBusinessV2SensitiveDisplayContext;
  mode: IdBusinessV2SensitiveDisplayMode;
};

@Injectable()
export class V2RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly identityService: V2IdentityService,
    private readonly securityService: SecurityService,
    private readonly supabaseAuthService: SupabaseAuthService
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
            { name: { contains: keyword } },
            { code: { contains: keyword } },
            { description: { contains: keyword } }
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
      sensitiveDisplayCatalog: listIdBusinessV2SensitiveDisplayCatalog(),
      sensitiveDisplayModeLabels: ID_BUSINESS_V2_SENSITIVE_MODE_LABELS,
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
    const sensitiveApprovalPermissionIds = this.requireSensitiveApprovalPermissionIds(
      dto.sensitiveApprovalPermissionIds,
      permissions
    );
    const sensitiveDisplayPolicies = this.requireSensitiveDisplayPolicies(
      dto.sensitiveDisplayPolicies,
      permissions
    );
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
                permissionId: permission.id,
                sensitiveApprovalRequired: sensitiveApprovalPermissionIds.has(permission.id)
              }))
            },
            sensitiveDisplayPolicies: {
              create: sensitiveDisplayPolicies.map((policy) => ({
                ...policy,
                createdByUserId: operator.id,
                updatedByUserId: operator.id
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
        await bumpV2ScopeVersions(transaction, ['employees', 'security']);
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
    const expectedUpdatedAt = this.normalizeExpectedUpdatedAt(dto.expectedUpdatedAt);
    if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new ConflictException('角色已被其他管理员更新，请刷新列表后重试。');
    }

    const name =
      dto.name === undefined ? undefined : this.normalizeRequiredText(dto.name, '角色名称', 100);
    const description =
      dto.description === undefined ? undefined : this.normalizeDescription(dto.description);
    const permissions =
      dto.permissionIds === undefined
        ? undefined
        : await this.requirePermissions(dto.permissionIds);
    if (dto.sensitiveApprovalPermissionIds !== undefined && permissions === undefined) {
      throw new BadRequestException('修改敏感资料审批策略时必须同时提交完整权限清单。');
    }
    const sensitiveApprovalPermissionIds = permissions
      ? this.requireSensitiveApprovalPermissionIds(dto.sensitiveApprovalPermissionIds, permissions)
      : undefined;
    const effectivePermissions =
      permissions ??
      existing.rolePermissions.map(({ permission }) => ({
        id: permission.id,
        code: permission.code
      }));
    const sensitiveDisplayPolicies =
      dto.sensitiveDisplayPolicies === undefined
        ? undefined
        : this.requireSensitiveDisplayPolicies(dto.sensitiveDisplayPolicies, effectivePermissions);
    const accessChanged =
      (permissions !== undefined &&
        this.hasRolePermissionChanges(
          existing,
          permissions,
          sensitiveApprovalPermissionIds ?? new Set()
        )) ||
      (sensitiveDisplayPolicies !== undefined &&
        this.hasSensitiveDisplayPolicyChanges(existing, sensitiveDisplayPolicies));
    if (
      name === undefined &&
      description === undefined &&
      permissions === undefined &&
      sensitiveApprovalPermissionIds === undefined &&
      sensitiveDisplayPolicies === undefined
    ) {
      throw new BadRequestException('请至少修改一项角色资料。');
    }

    let role: RoleDetailRecord;
    try {
      role = await this.prisma.$transaction(async (transaction) => {
        let revokedSessionCount = 0;
        if (accessChanged && existing.userRoles.length) {
          const revoked = await transaction.activeSession.updateMany({
            where: {
              userId: { in: existing.userRoles.map((assignment) => assignment.userId) },
              revokedAt: null
            },
            data: {
              revokedAt: new Date()
            }
          });
          revokedSessionCount = revoked.count;
        }
        if (permissions) {
          await transaction.rolePermission.deleteMany({
            where: {
              roleId: existing.id
            }
          });
          await transaction.rolePermission.createMany({
            data: permissions.map((permission) => ({
              roleId: existing.id,
              permissionId: permission.id,
              sensitiveApprovalRequired: sensitiveApprovalPermissionIds?.has(permission.id) ?? false
            }))
          });
        }
        if (sensitiveDisplayPolicies !== undefined) {
          await transaction.idBusinessV2SensitiveDisplayPolicy.deleteMany({
            where: { roleId: existing.id }
          });
          if (sensitiveDisplayPolicies.length) {
            await transaction.idBusinessV2SensitiveDisplayPolicy.createMany({
              data: sensitiveDisplayPolicies.map((policy) => ({
                roleId: existing.id,
                ...policy,
                createdByUserId: operator.id,
                updatedByUserId: operator.id
              }))
            });
          }
        } else if (permissions) {
          const selectedPermissionCodes = new Set(permissions.map((permission) => permission.code));
          const obsoletePolicyIds = existing.sensitiveDisplayPolicies
            .filter((policy) => {
              const descriptor = getIdBusinessV2SensitiveDescriptorByKey(policy.fieldKey);
              return !descriptor || !selectedPermissionCodes.has(descriptor.permissionCode);
            })
            .map((policy) => policy.id);
          if (obsoletePolicyIds.length) {
            await transaction.idBusinessV2SensitiveDisplayPolicy.deleteMany({
              where: { id: { in: obsoletePolicyIds } }
            });
          }
        }
        const updated = await transaction.role.update({
          where: {
            id: existing.id,
            updatedAt: expectedUpdatedAt
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
            afterData: {
              ...this.toAuditData(updated),
              accessChanged,
              revokedSessionCount
            },
            remark: `管理员更新角色：${updated.name}（${updated.code}）`
          },
          transaction
        );
        await bumpV2ScopeVersions(transaction, ['employees', 'security']);
        return updated;
      });
    } catch (error) {
      if (this.isRecordNotFoundError(error)) {
        throw new ConflictException('角色已被其他管理员更新，请刷新列表后重试。');
      }
      throw error;
    }

    if (accessChanged) {
      for (const assignment of existing.userRoles) {
        this.identityService.invalidateAuthenticatedUser(assignment.userId);
      }
      this.securityService.invalidateActiveSessionCache();
      this.supabaseAuthService.invalidateAccessTokenCache();
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
      where: {
        code: { notIn: [...DEPRECATED_PERMISSION_CODES] }
      },
      select: PERMISSION_SELECT,
      orderBy: PERMISSION_ORDER_BY
    });
  }

  private async assertCodeAvailable(code: string) {
    const existing = await this.prisma.role.findFirst({
      where: {
        code: {
          equals: code
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
        },
        code: { notIn: [...DEPRECATED_PERMISSION_CODES] }
      },
      select: {
        id: true,
        code: true
      }
    });
    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('所选权限不存在或已停用，请刷新后重试。');
    }
    return permissions;
  }

  private requireSensitiveApprovalPermissionIds(
    permissionIdsInput: string[] | undefined,
    permissions: Array<{ id: string; code: string }>
  ) {
    const selected = new Set(
      (Array.isArray(permissionIdsInput) ? permissionIdsInput : []).map((permissionId) =>
        this.normalizeUuid(permissionId, '敏感资料权限')
      )
    );
    const permissionById = new Map(permissions.map((permission) => [permission.id, permission]));
    for (const permissionId of selected) {
      const permission = permissionById.get(permissionId);
      if (!permission) {
        throw new BadRequestException('敏感资料审批策略必须属于当前已选择的权限。');
      }
      if (!ID_BUSINESS_V2_SENSITIVE_PERMISSION_CODES.has(permission.code)) {
        throw new BadRequestException('所选权限不是可配置审批的敏感资料权限。');
      }
    }
    return selected;
  }

  private requireSensitiveDisplayPolicies(
    input: V2SensitiveDisplayPolicyDto[] | undefined,
    permissions: Array<{ id: string; code: string }>
  ): SensitiveDisplayPolicyInput[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 100) {
      throw new BadRequestException('敏感资料展示策略数量无效。');
    }
    const permissionCodes = new Set(permissions.map((permission) => permission.code));
    const unique = new Set<string>();
    return input.map((item) => {
      const fieldKey = typeof item.fieldKey === 'string' ? item.fieldKey.trim() : '';
      const descriptor = getIdBusinessV2SensitiveDescriptorByKey(fieldKey);
      if (!descriptor || !permissionCodes.has(descriptor.permissionCode)) {
        throw new BadRequestException('敏感资料展示策略必须属于当前已选择的权限。');
      }
      const context = item.context as IdBusinessV2SensitiveDisplayContext;
      if (
        !(descriptor.contexts as readonly IdBusinessV2SensitiveDisplayContext[]).includes(context)
      ) {
        throw new BadRequestException('敏感资料展示场景无效。');
      }
      const mode = item.mode as IdBusinessV2SensitiveDisplayMode;
      const allowedModes = getIdBusinessV2SensitiveAllowedDisplayModes(descriptor, context);
      if (!allowedModes.includes(mode)) {
        throw new BadRequestException('敏感资料展示方式无效。');
      }
      const key = `${fieldKey}:${context}`;
      if (unique.has(key)) throw new BadRequestException('敏感资料展示策略存在重复项。');
      unique.add(key);
      return { fieldKey, context, mode };
    });
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

  private normalizeExpectedUpdatedAt(value: string | undefined) {
    const normalized = value?.trim();
    const parsed = normalized ? new Date(normalized) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('缺少有效的角色版本，请刷新列表后重试。');
    }
    return parsed;
  }

  private hasRolePermissionChanges(
    existing: RoleDetailRecord,
    permissions: Array<{ id: string }>,
    sensitiveApprovalPermissionIds: Set<string>
  ) {
    if (existing.rolePermissions.length !== permissions.length) return true;
    const existingByPermissionId = new Map(
      existing.rolePermissions.map((assignment) => [
        assignment.permissionId,
        assignment.sensitiveApprovalRequired
      ])
    );
    return permissions.some(
      (permission) =>
        existingByPermissionId.get(permission.id) !==
        sensitiveApprovalPermissionIds.has(permission.id)
    );
  }

  private hasSensitiveDisplayPolicyChanges(
    existing: RoleDetailRecord,
    policies: SensitiveDisplayPolicyInput[]
  ) {
    if (existing.sensitiveDisplayPolicies.length !== policies.length) return true;
    const existingModes = new Map(
      existing.sensitiveDisplayPolicies.map((policy) => [
        `${policy.fieldKey}:${policy.context}`,
        policy.mode
      ])
    );
    return policies.some(
      (policy) => existingModes.get(`${policy.fieldKey}:${policy.context}`) !== policy.mode
    );
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
    const selectedPermissions = (
      role.code === 'admin' && allPermissions.length
        ? allPermissions
        : role.rolePermissions.map(({ permission }) => permission)
    ).filter((permission) => !DEPRECATED_PERMISSION_CODES.has(permission.code));
    const permissions = selectedPermissions.map((permission) => ({
      ...permission,
      sensitive: ID_BUSINESS_V2_SENSITIVE_PERMISSION_CODES.has(permission.code)
    }));
    return {
      id: role.id,
      name: role.name,
      code: role.code,
      description: role.description,
      isSystemRole: role.code === 'admin',
      permissions,
      permissionIds: permissions.map((permission) => permission.id),
      sensitiveApprovalPermissionIds:
        role.code === 'admin'
          ? []
          : role.rolePermissions
              .filter((assignment) => assignment.sensitiveApprovalRequired)
              .map(({ permission }) => permission.id),
      sensitiveDisplayPolicies:
        role.code === 'admin'
          ? listIdBusinessV2SensitiveDisplayCatalog().map((item) => ({
              fieldKey: item.fieldKey,
              context: item.context,
              mode:
                item.context === 'audit'
                  ? ('masked' as const)
                  : !getIdBusinessV2SensitiveDescriptorByKey(item.fieldKey)?.secret
                    ? ('full' as const)
                    : ('reveal_direct' as const)
            }))
          : role.sensitiveDisplayPolicies.map((policy) => ({
              fieldKey: policy.fieldKey,
              context: policy.context,
              mode: policy.mode
            })),
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
      sensitiveApprovalPermissionCodes: role.rolePermissions
        .filter((assignment) => assignment.sensitiveApprovalRequired)
        .map(({ permission }) => permission.code)
        .sort(),
      sensitiveDisplayPolicies: role.sensitiveDisplayPolicies.map((policy) => ({
        fieldKey: policy.fieldKey,
        context: policy.context,
        mode: policy.mode
      })),
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

  private isRecordNotFoundError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2025'
    );
  }
}
