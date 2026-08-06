import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import type { Prisma, UserStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { hashPassword } from '../../auth/password-hasher';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SecurityService } from '../../security/security.service';
import { V2IdentityService } from '../v2-identity.service';
import type {
  CreateV2EmployeeDto,
  ListV2EmployeesQuery,
  UpdateV2EmployeeDto
} from './v2-employees.dto';

const EMPLOYEE_SORT_FIELDS: Record<string, keyof Prisma.UserOrderByWithRelationInput> = {
  username: 'username',
  displayName: 'displayName',
  status: 'status',
  lastLoginAt: 'lastLoginAt',
  createdAt: 'createdAt'
};

const EMPLOYEE_INCLUDE = {
  userRoles: {
    include: {
      role: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    },
    orderBy: {
      role: {
        code: 'asc' as const
      }
    }
  },
  v2AuthIdentity: {
    select: {
      enabled: true,
      mustResetPassword: true,
      lastAuthenticatedAt: true
    }
  },
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.UserInclude;

type EmployeeRecord = Prisma.UserGetPayload<{ include: typeof EMPLOYEE_INCLUDE }> & {
  _count?: {
    activeSessions: number;
  };
};

@Injectable()
export class V2EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly securityService: SecurityService,
    private readonly identityService: V2IdentityService,
    private readonly supabaseAuthService: SupabaseAuthService
  ) {}

  async list(query: ListV2EmployeesQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeOptionalText(query.keyword, '搜索关键词', 100);
    const status = this.parseStatus(query.status, false);
    const roleId = query.roleId ? this.normalizeUuid(query.roleId, '角色') : undefined;
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status,
      userRoles: roleId
        ? {
            some: {
              roleId
            }
          }
        : undefined,
      OR: keyword
        ? [
            { username: { contains: keyword, mode: 'insensitive' } },
            { displayName: { contains: keyword, mode: 'insensitive' } }
          ]
        : undefined
    };
    const now = new Date();
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: {
          ...EMPLOYEE_INCLUDE,
          _count: {
            select: {
              activeSessions: {
                where: {
                  revokedAt: null,
                  expiresAt: {
                    gt: now
                  }
                }
              }
            }
          }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.user.count({ where })
    ]);

    return {
      items: items.map((employee) => this.toResponse(employee)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async bootstrap(query: ListV2EmployeesQuery) {
    const [list, roles] = await Promise.all([
      this.list(query),
      this.prisma.role.findMany({
        select: {
          id: true,
          code: true,
          name: true,
          description: true
        },
        orderBy: [{ name: 'asc' }, { code: 'asc' }]
      })
    ]);
    return {
      list,
      roles,
      generatedAt: new Date().toISOString()
    };
  }

  async create(dto: CreateV2EmployeeDto, operator: AuthenticatedUser) {
    const username = this.normalizeUsername(dto.username);
    const displayName = this.normalizeRequiredText(dto.displayName, '员工姓名', 100);
    const initialPassword = dto.initialPassword ?? '';
    const roles = await this.requireRoles(dto.roleIds);
    await this.securityService.assertPasswordMeetsPolicy(initialPassword);
    await this.assertUsernameAvailable(username);

    const passwordHash = await hashPassword(initialPassword);
    const localAuthUserId = randomUUID();
    const authEmail = `employee.${localAuthUserId.replaceAll('-', '')}@v2-auth.invalid`;
    let authUserId: string = localAuthUserId;
    let providerUserCreated = false;

    if (this.supabaseAuthService.isEnabled()) {
      const providerUser = await this.supabaseAuthService.createManagedUser({
        email: authEmail,
        password: initialPassword,
        username,
        displayName
      });
      authUserId = providerUser.authUserId;
      providerUserCreated = true;
    }

    try {
      const employee = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.user.create({
          data: {
            username,
            displayName,
            passwordHash,
            status: 'active',
            createdByUserId: operator.id,
            userRoles: {
              create: roles.map((role) => ({
                roleId: role.id
              }))
            },
            v2AuthIdentity: {
              create: {
                authUserId,
                authEmail,
                usernameNormalized: username,
                enabled: true,
                mustResetPassword: true
              }
            }
          },
          include: EMPLOYEE_INCLUDE
        });
        await this.auditLogsService.create(
          {
            userId: operator.id,
            module: 'employees',
            action: 'employee.create',
            objectType: 'user',
            objectId: created.id,
            afterData: this.toAuditData(created),
            remark: `管理员开通员工账号：${created.username}`
          },
          transaction
        );
        return created;
      });
      return this.toResponse(employee);
    } catch (error) {
      if (providerUserCreated) {
        try {
          await this.supabaseAuthService.deleteManagedUser(authUserId);
        } catch (compensationError) {
          throw new ServiceUnavailableException(
            '员工账号未完成开通，且 Supabase 临时账号清理失败，请联系管理员核对。',
            { cause: compensationError }
          );
        }
      }
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('员工账号已存在。');
      }
      throw error;
    }
  }

  async update(idInput: string, dto: UpdateV2EmployeeDto, operator: AuthenticatedUser) {
    const id = this.normalizeUuid(idInput, '员工');
    const existing = await this.findEmployeeOrThrow(id);
    const displayName =
      dto.displayName === undefined
        ? undefined
        : this.normalizeRequiredText(dto.displayName, '员工姓名', 100);
    const status = dto.status === undefined ? undefined : this.parseStatus(dto.status, true);
    const roles = dto.roleIds === undefined ? undefined : await this.requireRoles(dto.roleIds);

    if (displayName === undefined && status === undefined && roles === undefined) {
      throw new BadRequestException('请至少修改一项员工资料。');
    }
    if (operator.id === existing.id && (status !== undefined || roles !== undefined)) {
      throw new ForbiddenException('不能修改自己的状态或角色。');
    }

    const employee = await this.prisma.$transaction(async (transaction) => {
      const revokedAt = new Date();
      let revokedSessionCount = 0;
      if (status === 'disabled') {
        const revoked = await transaction.activeSession.updateMany({
          where: {
            userId: existing.id,
            revokedAt: null
          },
          data: {
            revokedAt
          }
        });
        revokedSessionCount = revoked.count;
      }
      if (roles) {
        await transaction.userRole.deleteMany({
          where: {
            userId: existing.id
          }
        });
        await transaction.userRole.createMany({
          data: roles.map((role) => ({
            userId: existing.id,
            roleId: role.id
          }))
        });
      }
      if (status !== undefined) {
        await transaction.v2AuthIdentity.updateMany({
          where: {
            userId: existing.id
          },
          data: {
            enabled: status === 'active'
          }
        });
      }
      const updated = await transaction.user.update({
        where: {
          id: existing.id
        },
        data: {
          displayName,
          status
        },
        include: EMPLOYEE_INCLUDE
      });
      await this.auditLogsService.create(
        {
          userId: operator.id,
          module: 'employees',
          action: 'employee.update',
          objectType: 'user',
          objectId: updated.id,
          beforeData: this.toAuditData(existing),
          afterData: {
            ...this.toAuditData(updated),
            revokedSessionCount
          },
          remark: `管理员更新员工账号：${updated.username}`
        },
        transaction
      );
      return updated;
    });

    this.identityService.invalidateAuthenticatedUser(existing.id);
    this.securityService.invalidateActiveSessionCache();
    this.supabaseAuthService.invalidateAccessTokenCache();
    return this.toResponse(employee);
  }

  private async findEmployeeOrThrow(id: string) {
    const employee = await this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: EMPLOYEE_INCLUDE
    });
    if (!employee) {
      throw new NotFoundException('员工账号不存在或已删除。');
    }
    return employee;
  }

  private async assertUsernameAvailable(username: string) {
    const existing = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: username,
          mode: 'insensitive'
        },
        deletedAt: null
      },
      select: {
        id: true
      }
    });
    if (existing) {
      throw new ConflictException('员工账号已存在。');
    }
  }

  private async requireRoles(roleIdsInput: string[] | undefined) {
    const roleIds = [
      ...new Set(
        (Array.isArray(roleIdsInput) ? roleIdsInput : []).map((roleId) =>
          this.normalizeUuid(roleId, '角色')
        )
      )
    ];
    if (!roleIds.length) {
      throw new BadRequestException('请至少选择一个角色。');
    }
    if (roleIds.length > 20) {
      throw new BadRequestException('员工角色数量不能超过 20 个。');
    }
    const roles = await this.prisma.role.findMany({
      where: {
        id: {
          in: roleIds
        }
      },
      select: {
        id: true,
        code: true,
        name: true
      }
    });
    if (roles.length !== roleIds.length) {
      throw new BadRequestException('所选角色不存在，请刷新后重试。');
    }
    return roles;
  }

  private normalizeUsername(value: string | undefined) {
    const username = (value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,99}$/.test(username)) {
      throw new BadRequestException('登录账号需为 3 至 100 位小写字母、数字、点、下划线或短横线。');
    }
    return username;
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

  private parseStatus(value: string | undefined, required: boolean): UserStatus | undefined {
    if (!value && !required) return undefined;
    if (value === 'active' || value === 'disabled') return value;
    throw new BadRequestException('员工状态不正确。');
  }

  private buildOrderBy(query: ListV2EmployeesQuery): Prisma.UserOrderByWithRelationInput[] {
    const sortField = query.sortBy ? EMPLOYEE_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder =
      query.sortOrder === 'asc' || query.sortOrder === 'desc' ? query.sortOrder : null;
    if (query.sortOrder && !sortOrder) {
      throw new BadRequestException('排序方向不正确。');
    }
    if (!sortField || !sortOrder) {
      return [{ createdAt: 'desc' }];
    }
    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  private toResponse(employee: EmployeeRecord) {
    return {
      id: employee.id,
      username: employee.username,
      displayName: employee.displayName,
      status: employee.status,
      lastLoginAt: employee.lastLoginAt?.toISOString() ?? null,
      createdAt: employee.createdAt.toISOString(),
      updatedAt: employee.updatedAt.toISOString(),
      createdBy: employee.createdBy,
      roles: employee.userRoles.map(({ role }) => role),
      mustResetPassword: employee.v2AuthIdentity?.mustResetPassword ?? false,
      lastAuthenticatedAt: employee.v2AuthIdentity?.lastAuthenticatedAt?.toISOString() ?? null,
      activeSessionCount: employee._count?.activeSessions ?? 0
    };
  }

  private toAuditData(employee: EmployeeRecord) {
    return {
      id: employee.id,
      username: employee.username,
      displayName: employee.displayName,
      status: employee.status,
      roleCodes: employee.userRoles.map(({ role }) => role.code),
      mustResetPassword: employee.v2AuthIdentity?.mustResetPassword ?? false
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
