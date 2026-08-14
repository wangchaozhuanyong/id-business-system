import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination } from '../../common/pagination';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import type {
  CreateIdBusinessV2SensitiveAccessRequestDto,
  DecideIdBusinessV2SensitiveAccessRequestDto,
  ListIdBusinessV2SensitiveAccessRequestsQuery
} from './dto/id-business-v2-sensitive-access.dto';
import {
  ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG,
  getIdBusinessV2SensitiveDescriptorByKey,
  getIdBusinessV2SensitiveAllowedDisplayModes,
  requireIdBusinessV2SensitiveAccessDescriptor,
  type IdBusinessV2SensitiveAccessDescriptor,
  type IdBusinessV2SensitiveAccessMode,
  type IdBusinessV2SensitiveDisplayContext,
  type IdBusinessV2SensitiveDisplayMode
} from './id-business-v2-sensitive-access.catalog';
import {
  IdBusinessV2SensitiveAccessRepository,
  type SensitiveApprovalFilter,
  type SensitiveApprovalRecord,
  type SensitivePermissionGrant
} from './persistence/id-business-v2-sensitive-access.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_DURATION_MS = 15 * 60 * 1000;
const DISPLAY_MODE_PRIORITY: Record<IdBusinessV2SensitiveDisplayMode, number> = {
  hidden: 0,
  masked: 1,
  reveal_approval: 2,
  reveal_direct: 3,
  full: 4
};
interface SensitiveAccessAuditMeta {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class IdBusinessV2SensitiveAccessService {
  constructor(
    private readonly repository: IdBusinessV2SensitiveAccessRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

  async listPolicies(operator?: AuthenticatedUser) {
    const current = this.requireOperator(operator);
    const grants = current.roles.includes('admin')
      ? []
      : await this.listSensitivePermissionGrants(current.id);
    const byPermission = this.groupGrantsByPermission(grants);
    return {
      items: ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.map((descriptor) => ({
        ...descriptor,
        mode: this.resolveMode(current, descriptor.permissionCode, byPermission)
      }))
    };
  }

  async resolveDisplayMode(
    operatorInput: AuthenticatedUser | undefined,
    fieldKey: string,
    context: IdBusinessV2SensitiveDisplayContext,
    tx?: V2CommandTransaction
  ): Promise<IdBusinessV2SensitiveDisplayMode> {
    const operator = this.requireOperator(operatorInput);
    const descriptor = getIdBusinessV2SensitiveDescriptorByKey(fieldKey);
    if (
      !descriptor ||
      !(descriptor.contexts as readonly IdBusinessV2SensitiveDisplayContext[]).includes(context)
    ) {
      throw new BadRequestException('敏感资料字段或使用场景无效');
    }
    if (operator.roles.includes('admin')) {
      if (context === 'audit') return 'masked';
      return descriptor.secret ? 'reveal_direct' : 'full';
    }
    if (!operator.permissions.includes(descriptor.permissionCode)) return 'masked';

    const [policies, grants] = await Promise.all([
      this.repository.listSensitiveDisplayPolicies(operator.id, [descriptor.key], [context], tx),
      this.listSensitivePermissionGrants(operator.id, descriptor.permissionCode, tx)
    ]);
    const applicablePolicies = policies.filter((policy) =>
      policy.role.rolePermissions.some(
        (assignment) => assignment.permission.code === descriptor.permissionCode
      )
    );
    const explicitRoleIds = new Set(applicablePolicies.map((policy) => policy.role.id));
    const applicableModes: IdBusinessV2SensitiveDisplayMode[] = applicablePolicies
      .map((policy) => policy.mode)
      .map((mode) => (descriptor.secret && mode === 'full' ? 'reveal_direct' : mode));
    for (const grant of grants) {
      if (explicitRoleIds.has(grant.roleId)) continue;
      applicableModes.push(
        this.resolveLegacyDisplayMode(descriptor, context, grant.sensitiveApprovalRequired)
      );
    }
    if (!applicableModes.length) return 'masked';
    return applicableModes.reduce((current, mode) =>
      DISPLAY_MODE_PRIORITY[mode] > DISPLAY_MODE_PRIORITY[current] ? mode : current
    );
  }

  async resolveDisplayModes(
    operator: AuthenticatedUser | undefined,
    fieldKeys: string[],
    context: IdBusinessV2SensitiveDisplayContext,
    tx?: V2CommandTransaction
  ) {
    const uniqueFieldKeys = [...new Set(fieldKeys)];
    const entries = await Promise.all(
      uniqueFieldKeys.map(
        async (fieldKey) =>
          [fieldKey, await this.resolveDisplayMode(operator, fieldKey, context, tx)] as const
      )
    );
    return Object.fromEntries(entries) as Record<string, IdBusinessV2SensitiveDisplayMode>;
  }

  async authorize(
    tx: V2CommandTransaction,
    input: {
      module: string;
      fieldName: string;
      objectType: string;
      objectId: string;
      approvalId?: string | null;
      context?: IdBusinessV2SensitiveDisplayContext;
      operator?: AuthenticatedUser;
      now?: Date;
    }
  ) {
    const operator = this.requireOperator(input.operator);
    const descriptor = requireIdBusinessV2SensitiveAccessDescriptor(input);
    const displayMode = await this.resolveDisplayMode(
      operator,
      descriptor.key,
      input.context ?? descriptor.contexts[0],
      tx
    );
    const mode: IdBusinessV2SensitiveAccessMode = operator.roles.includes('admin')
      ? 'admin_bypass'
      : displayMode === 'reveal_approval'
        ? 'approval_required'
        : displayMode === 'reveal_direct' || displayMode === 'full'
          ? 'direct'
          : 'denied';

    if (mode === 'denied') {
      throw new ForbiddenException('当前账号无权查看该敏感资料');
    }
    if (mode === 'admin_bypass' || mode === 'direct') {
      return {
        mode,
        approvalId: null,
        reason: mode === 'admin_bypass' ? '管理员直接查看' : '角色权限直接查看'
      } as const;
    }
    if (!input.approvalId?.trim()) {
      throw new ForbiddenException({
        code: 'SENSITIVE_APPROVAL_REQUIRED',
        message: '该字段需要管理员批准后才能查看'
      });
    }

    await this.repository.verifyApproval(tx, {
      approvalId: input.approvalId,
      requesterId: operator.id,
      module: descriptor.module,
      fieldName: descriptor.fieldName,
      objectType: descriptor.objectType,
      objectId: input.objectId,
      now: input.now
    });
    const approval = await this.repository.findApprovalReason(tx, input.approvalId.trim());
    if (!approval) throw new NotFoundException('敏感资料查看申请不存在');
    return { mode: 'approval', approvalId: approval.id, reason: approval.reason } as const;
  }

  createRequest(
    dto: CreateIdBusinessV2SensitiveAccessRequestDto,
    operator?: AuthenticatedUser,
    meta: SensitiveAccessAuditMeta = {}
  ) {
    const requester = this.requireOperator(operator);
    const descriptor = requireIdBusinessV2SensitiveAccessDescriptor(dto);
    const objectId = this.normalizeUuid(dto.objectId, '资料');
    const reason = this.normalizeRequiredText(dto.reason, '申请原因', 200, 2);

    return this.transactionManager.execute(
      async (tx) => {
        const displayMode = await this.resolveDisplayMode(
          requester,
          descriptor.key,
          descriptor.contexts[0],
          tx
        );
        const mode =
          displayMode === 'reveal_approval'
            ? 'approval_required'
            : displayMode === 'reveal_direct' || displayMode === 'full'
              ? 'direct'
              : 'denied';
        if (mode === 'denied') throw new ForbiddenException('当前账号无权申请查看该资料');
        if (mode !== 'approval_required') {
          throw new BadRequestException('当前角色可以直接查看该字段，无需提交审批');
        }

        const targetLabel = await this.requireTargetLabel(tx, descriptor, objectId);
        const existing = await this.repository.findPending(tx, {
          requesterId: requester.id,
          module: descriptor.module,
          fieldName: descriptor.fieldName,
          objectType: descriptor.objectType,
          objectId
        });
        if (existing) return this.toResponse(existing, descriptor, targetLabel);

        const approval = await this.repository.createPending(tx, {
          requesterId: requester.id,
          module: descriptor.module,
          fieldName: descriptor.fieldName,
          objectType: descriptor.objectType,
          objectId,
          reason
        });
        await this.transactionalAudit.append(tx, {
          userId: requester.id,
          module: 'id_business_v2_sensitive_access',
          action: 'id_business_v2.sensitive_access.request',
          objectType: 'sensitive_access_approval',
          objectId: approval.id,
          afterData: toV2JsonDocument({
            module: descriptor.module,
            fieldName: descriptor.fieldName,
            objectType: descriptor.objectType,
            objectId,
            reason,
            status: 'pending'
          }),
          ip: meta.ip,
          userAgent: meta.userAgent,
          remark: `申请查看敏感资料：${descriptor.label} / ${targetLabel}`
        });
        return this.toResponse(approval, descriptor, targetLabel);
      },
      {
        requestId: meta.requestId ?? randomUUID(),
        operator: requester,
        retryMode: 'none',
        uniqueConflictMessage: '已有相同的待审批申请，请勿重复提交'
      }
    );
  }

  async listMyRequests(
    query: ListIdBusinessV2SensitiveAccessRequestsQuery,
    operator?: AuthenticatedUser
  ) {
    const requester = this.requireOperator(operator);
    const pagination = getPagination(query);
    const status = this.parseStatus(query.status);
    const objectId = query.objectId ? this.normalizeUuid(query.objectId, '资料') : undefined;
    const filter: SensitiveApprovalFilter = {
      requesterId: requester.id,
      module: query.module || undefined,
      fieldName: query.fieldName || undefined,
      objectType: query.objectType || undefined,
      objectId,
      status
    };
    const { items, total } = await this.repository.list(filter, pagination.skip, pagination.take);
    return {
      items: await this.toResponses(items),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async listPendingSummary(operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    const { items, pendingCount } = await this.repository.listPendingSummary();
    return {
      pendingCount,
      items: await this.toResponses(items),
      generatedAt: new Date().toISOString()
    };
  }

  async listApprovals(
    query: ListIdBusinessV2SensitiveAccessRequestsQuery,
    operator?: AuthenticatedUser
  ) {
    this.requireAdmin(operator);
    const pagination = getPagination(query);
    const status = this.parseStatus(query.status);
    const filter: SensitiveApprovalFilter = {
      module: query.module || undefined,
      fieldName: query.fieldName || undefined,
      objectType: query.objectType || undefined,
      objectId: query.objectId ? this.normalizeUuid(query.objectId, '资料') : undefined,
      status
    };
    const { items, total } = await this.repository.list(filter, pagination.skip, pagination.take);
    return {
      items: await this.toResponses(items),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  decide(
    idInput: string,
    dto: DecideIdBusinessV2SensitiveAccessRequestDto,
    operator?: AuthenticatedUser,
    meta: SensitiveAccessAuditMeta = {}
  ) {
    const admin = this.requireAdmin(operator);
    const id = this.normalizeUuid(idInput, '申请');
    const decision = dto.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new BadRequestException('审批结果无效');
    }
    const decisionNote = this.normalizeOptionalText(dto.decisionNote, '审批说明', 200);
    if (decision === 'rejected' && (!decisionNote || decisionNote.length < 2)) {
      throw new BadRequestException('拒绝时请填写 2 至 200 个字符的原因');
    }

    return this.transactionManager.execute(
      async (tx, context) => {
        const approval = await this.repository.findById(tx, id);
        if (!approval) throw new NotFoundException('敏感资料查看申请不存在');
        if (approval.status !== 'pending') {
          throw new ConflictException('该申请已被其他管理员处理');
        }
        if (approval.requesterId === admin.id) {
          throw new BadRequestException('管理员无需审批自己的敏感资料访问');
        }

        const expiresAt =
          decision === 'approved'
            ? new Date(context.businessTime.getTime() + APPROVAL_DURATION_MS)
            : null;
        const updated = await this.repository.decidePending(tx, {
          id,
          status: decision,
          approverId: admin.id,
          decisionNote,
          approvedAt: decision === 'approved' ? context.businessTime : null,
          expiresAt
        });
        if (updated.count !== 1) throw new ConflictException('该申请已被其他管理员处理');

        const decided = await this.repository.findById(tx, id);
        if (!decided) throw new NotFoundException('敏感资料查看申请不存在');
        const descriptor = requireIdBusinessV2SensitiveAccessDescriptor(decided);
        const targetLabel = decided.objectId
          ? ((await this.resolveTargetLabel(descriptor, decided.objectId, tx)) ?? '资料已删除')
          : '未指定资料';
        await this.transactionalAudit.append(tx, {
          userId: admin.id,
          module: 'id_business_v2_sensitive_access',
          action: `id_business_v2.sensitive_access.${decision}`,
          objectType: 'sensitive_access_approval',
          objectId: decided.id,
          beforeData: toV2JsonDocument({ status: approval.status }),
          afterData: toV2JsonDocument({
            status: decision,
            decisionNote,
            approvedAt: decided.approvedAt?.toISOString() ?? null,
            expiresAt: decided.expiresAt?.toISOString() ?? null
          }),
          ip: meta.ip,
          userAgent: meta.userAgent,
          remark: `${decision === 'approved' ? '批准' : '拒绝'}敏感资料申请：${descriptor.label} / ${targetLabel}`
        });
        return this.toResponse(decided, descriptor, targetLabel);
      },
      {
        requestId: meta.requestId ?? randomUUID(),
        operator: admin,
        retryMode: 'none'
      }
    );
  }

  private listSensitivePermissionGrants(
    userId: string,
    permissionCode?: string,
    tx?: V2CommandTransaction
  ) {
    const permissionCodes = permissionCode
      ? [permissionCode]
      : [...new Set(ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.map((item) => item.permissionCode))];
    return this.repository.listSensitivePermissionGrants(userId, permissionCodes, tx);
  }

  private groupGrantsByPermission(grants: SensitivePermissionGrant[]) {
    const result = new Map<string, boolean[]>();
    for (const grant of grants) {
      const items = result.get(grant.permission.code) ?? [];
      items.push(grant.sensitiveApprovalRequired);
      result.set(grant.permission.code, items);
    }
    return result;
  }

  private resolveMode(
    operator: AuthenticatedUser,
    permissionCode: string,
    byPermission: Map<string, boolean[]>
  ): IdBusinessV2SensitiveAccessMode {
    if (operator.roles.includes('admin')) return 'admin_bypass';
    if (!operator.permissions.includes(permissionCode)) return 'denied';
    const grants = byPermission.get(permissionCode) ?? [];
    if (!grants.length) return 'denied';
    return grants.some((required) => !required) ? 'direct' : 'approval_required';
  }

  private resolveLegacyDisplayMode(
    descriptor: IdBusinessV2SensitiveAccessDescriptor,
    context: IdBusinessV2SensitiveDisplayContext,
    approvalRequired: boolean
  ): IdBusinessV2SensitiveDisplayMode {
    const allowedModes = getIdBusinessV2SensitiveAllowedDisplayModes(descriptor, context);
    if (approvalRequired) {
      return allowedModes.includes('reveal_approval') ? 'reveal_approval' : 'masked';
    }
    if (allowedModes.includes('reveal_direct')) return 'reveal_direct';
    if (allowedModes.includes('full')) return 'full';
    return 'masked';
  }

  private async requireTargetLabel(
    tx: V2CommandTransaction,
    descriptor: IdBusinessV2SensitiveAccessDescriptor,
    objectId: string
  ) {
    const label = await this.resolveTargetLabel(descriptor, objectId, tx);
    if (!label) throw new NotFoundException('申请查看的资料不存在或已删除');
    return label;
  }

  private async resolveTargetLabel(
    descriptor: IdBusinessV2SensitiveAccessDescriptor,
    objectId: string,
    tx?: V2CommandTransaction
  ) {
    return this.repository.resolveTargetLabel(descriptor.objectType, objectId, tx);
  }

  private async toResponses(items: SensitiveApprovalRecord[], tx?: V2CommandTransaction) {
    return Promise.all(
      items.map(async (item) => {
        const descriptor = requireIdBusinessV2SensitiveAccessDescriptor(item);
        const targetLabel = item.objectId
          ? ((await this.resolveTargetLabel(descriptor, item.objectId, tx)) ?? '资料已删除')
          : '未指定资料';
        return this.toResponse(item, descriptor, targetLabel);
      })
    );
  }

  private toResponse(
    approval: SensitiveApprovalRecord,
    descriptor: IdBusinessV2SensitiveAccessDescriptor,
    targetLabel: string
  ) {
    return {
      id: approval.id,
      requesterId: approval.requesterId,
      requester: approval.requester,
      approverId: approval.approverId,
      approver: approval.approver,
      module: approval.module,
      fieldName: approval.fieldName,
      fieldLabel: descriptor.label,
      permissionCode: descriptor.permissionCode,
      objectType: approval.objectType,
      objectId: approval.objectId,
      targetLabel,
      reason: approval.reason,
      status: approval.status,
      decisionNote: approval.decisionNote,
      approvedAt: approval.approvedAt?.toISOString() ?? null,
      expiresAt: approval.expiresAt?.toISOString() ?? null,
      createdAt: approval.createdAt.toISOString(),
      updatedAt: approval.updatedAt.toISOString()
    };
  }

  private requireOperator(operator?: AuthenticatedUser) {
    if (!operator) throw new ForbiddenException('请先登录');
    return operator;
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    const current = this.requireOperator(operator);
    if (!current.roles.includes('admin')) throw new ForbiddenException('仅管理员可以审核');
    return current;
  }

  private normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
    return normalized;
  }

  private normalizeRequiredText(value: unknown, label: string, maxLength: number, minLength = 1) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < minLength || normalized.length > maxLength) {
      throw new BadRequestException(`${label}必须为 ${minLength} 至 ${maxLength} 个字符`);
    }
    return normalized;
  }

  private normalizeOptionalText(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).trim();
    if (normalized.length > maxLength)
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    return normalized || null;
  }

  private parseStatus(value: unknown): SensitiveApprovalFilter['status'] {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === 'pending' || value === 'approved' || value === 'rejected') return value;
    throw new BadRequestException('申请状态无效');
  }
}
