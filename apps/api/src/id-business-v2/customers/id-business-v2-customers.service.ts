import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { PaginationQuery } from '../../common/pagination';
import { IdBusinessV2OptionsService } from '../options/public-api';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { CreateIdBusinessV2CustomerDto } from './dto/create-id-business-v2-customer.dto';
import type { RevealIdBusinessV2CustomerPhoneDto } from './dto/reveal-id-business-v2-customer-phone.dto';
import type { UpdateIdBusinessV2CustomerDto } from './dto/update-id-business-v2-customer.dto';
import {
  IdBusinessV2CustomerRepository,
  type CustomerWithRelations,
  type UpdateCustomerPersistenceInput
} from './persistence/id-business-v2-customer.repository';

interface ListIdBusinessV2CustomersQuery extends PaginationQuery {
  keyword?: string;
  sourceOptionId?: string;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface AuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

type CustomerRecordStatus = 'active' | 'disabled';

@Injectable()
export class IdBusinessV2CustomersService {
  constructor(
    private readonly repository: IdBusinessV2CustomerRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

  async list(query: ListIdBusinessV2CustomersQuery) {
    const keyword = this.normalizeNullableString(query.keyword);
    const normalizedContactKeyword = keyword ? keyword.replace(/[\s()-]/g, '') : null;
    const contactKeyword =
      normalizedContactKeyword && normalizedContactKeyword.length <= 40
        ? normalizedContactKeyword
        : null;
    const result = await this.repository.list({
      page: query.page,
      pageSize: query.pageSize,
      keyword,
      contactKeyword,
      contactHash: this.fieldEncryptionService.hash(contactKeyword),
      sourceOptionId: this.normalizeNullableString(query.sourceOptionId),
      tagOptionId: query.tagOptionId,
      serviceOptionId: query.serviceOptionId,
      recordStatus: this.parseRecordStatus(query.recordStatus, false),
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    });
    return { ...result, items: result.items.map((customer) => this.toResponse(customer)) };
  }

  async get(id: string) {
    return this.toResponse(await this.findCustomerOrThrow(id));
  }

  create(
    dto: CreateIdBusinessV2CustomerDto,
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const name = this.normalizeRequiredString(dto.name, '客户名称');
        const phone = this.normalizePhone(dto.phone, '手机号');
        const whatsapp = this.normalizePhone(dto.whatsapp, 'WhatsApp');
        const sourceOption = await this.optionsService.requireActiveOption(
          dto.sourceOptionId,
          'customer_source',
          '客户来源',
          true,
          tx
        );
        const tags = await this.optionsService.requireActiveOptions(
          dto.tagOptionIds,
          'customer_tag',
          '客户标签',
          tx
        );
        const customer = await this.repository.create(tx, {
          name,
          phoneEncrypted: this.fieldEncryptionService.encrypt(phone),
          phoneHash: this.fieldEncryptionService.hash(phone),
          phoneMasked: this.maskPhone(phone),
          phoneTail: phone ? phone.slice(-8) : null,
          wechat: this.normalizeOptionalText(dto.wechat, '微信', 120),
          qq: this.normalizeOptionalText(dto.qq, 'QQ', 120),
          whatsappEncrypted: this.fieldEncryptionService.encrypt(whatsapp),
          whatsappHash: this.fieldEncryptionService.hash(whatsapp),
          whatsappMasked: this.maskPhone(whatsapp),
          whatsappTail: whatsapp ? whatsapp.slice(-8) : null,
          sourceOptionId: sourceOption?.id ?? null,
          recordStatus: this.parseRecordStatus(dto.recordStatus, false) ?? 'active',
          remark: this.normalizeNullableString(dto.remark),
          tagOptionIds: tags.map((tag) => tag.id),
          operatorId: operator?.id
        });
        const response = this.toResponse(customer);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_customers',
          action: 'id_business_v2.customer.create',
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          afterData: toV2JsonDocument(response),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `创建 V2 客户：${customer.name}`
        });
        return response;
      },
      { requestId: requestMeta.requestId ?? randomUUID(), operator }
    );
  }

  update(
    id: string,
    dto: UpdateIdBusinessV2CustomerDto,
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.findCustomerOrThrowInTransaction(tx, id);
        const phone =
          dto.phone === undefined ? undefined : this.normalizePhone(dto.phone, '手机号');
        const whatsapp =
          dto.whatsapp === undefined ? undefined : this.normalizePhone(dto.whatsapp, 'WhatsApp');
        const sourceOption =
          dto.sourceOptionId === undefined
            ? undefined
            : await this.optionsService.requireActiveOption(
                dto.sourceOptionId,
                'customer_source',
                '客户来源',
                true,
                tx
              );
        const tags =
          dto.tagOptionIds === undefined
            ? undefined
            : await this.optionsService.requireActiveOptions(
                dto.tagOptionIds,
                'customer_tag',
                '客户标签',
                tx
              );
        const updateInput: UpdateCustomerPersistenceInput = {
          name:
            dto.name === undefined ? undefined : this.normalizeRequiredString(dto.name, '客户名称'),
          phoneEncrypted:
            phone === undefined ? undefined : this.fieldEncryptionService.encrypt(phone),
          phoneHash: phone === undefined ? undefined : this.fieldEncryptionService.hash(phone),
          phoneMasked: phone === undefined ? undefined : this.maskPhone(phone),
          phoneTail: phone === undefined ? undefined : (phone?.slice(-8) ?? null),
          wechat:
            dto.wechat === undefined
              ? undefined
              : this.normalizeOptionalText(dto.wechat, '微信', 120),
          qq: dto.qq === undefined ? undefined : this.normalizeOptionalText(dto.qq, 'QQ', 120),
          whatsappEncrypted:
            whatsapp === undefined ? undefined : this.fieldEncryptionService.encrypt(whatsapp),
          whatsappHash:
            whatsapp === undefined ? undefined : this.fieldEncryptionService.hash(whatsapp),
          whatsappMasked: whatsapp === undefined ? undefined : this.maskPhone(whatsapp),
          whatsappTail: whatsapp === undefined ? undefined : (whatsapp?.slice(-8) ?? null),
          sourceOptionId: sourceOption === undefined ? undefined : (sourceOption?.id ?? null),
          recordStatus:
            dto.recordStatus === undefined
              ? undefined
              : (this.parseRecordStatus(dto.recordStatus, true) ?? undefined),
          remark: dto.remark === undefined ? undefined : this.normalizeNullableString(dto.remark),
          tagOptionIds: tags?.map((tag) => tag.id),
          operatorId: operator?.id
        };
        const customer = await this.repository.update(tx, existing.id, updateInput);
        const response = this.toResponse(customer);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_customers',
          action: 'id_business_v2.customer.update',
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          beforeData: toV2JsonDocument(this.toResponse(existing)),
          afterData: toV2JsonDocument(response),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `修改 V2 客户：${existing.name}`
        });
        return response;
      },
      { requestId: requestMeta.requestId ?? randomUUID(), operator }
    );
  }

  remove(id: string, operator?: AuthenticatedUser, requestMeta: AuditRequestMeta = {}) {
    return this.transactionManager.execute(
      async (tx, context) => {
        const existing = await this.findCustomerOrThrowInTransaction(tx, id);
        await this.repository.softDelete(tx, {
          id: existing.id,
          deletedAt: context.businessTime,
          operatorId: operator?.id
        });
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_customers',
          action: 'id_business_v2.customer.delete',
          objectType: 'id_business_v2_customer',
          objectId: existing.id,
          beforeData: toV2JsonDocument(this.toResponse(existing)),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `删除 V2 客户：${existing.name}`
        });
        return { deleted: true };
      },
      { requestId: requestMeta.requestId ?? randomUUID(), operator }
    );
  }

  async revealPhone(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'phone', operator, requestMeta);
    return { customerId: result.customerId, phone: result.value, revealedAt: result.revealedAt };
  }

  async revealWhatsapp(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'whatsapp', operator, requestMeta);
    return { customerId: result.customerId, whatsapp: result.value, revealedAt: result.revealedAt };
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.repository.findById(id);
    if (!customer) throw new NotFoundException('客户不存在');
    return customer;
  }

  private async findCustomerOrThrowInTransaction(tx: V2CommandTransaction, id: string) {
    const customer = await this.repository.findByIdInTransaction(tx, id);
    if (!customer) throw new NotFoundException('客户不存在');
    return customer;
  }

  private parseRecordStatus(value: unknown, required: boolean): CustomerRecordStatus | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException('资料状态不能为空');
      return null;
    }
    if (value !== 'active' && value !== 'disabled') {
      throw new BadRequestException('资料状态无效');
    }
    return value;
  }

  private normalizeRequiredString(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${label}不能为空`);
    }
    const normalized = value.trim();
    if (normalized.length > 120) throw new BadRequestException(`${label}过长`);
    return normalized;
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestException('字段格式无效');
    return value.trim() || null;
  }

  private normalizeOptionalText(value: unknown, label: string, maximumLength: number) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > maximumLength) {
      throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`);
    }
    return normalized;
  }

  private normalizePhone(value: unknown, label = '手机号') {
    const phone = this.normalizeNullableString(value);
    if (!phone) return null;
    const normalized = phone.replace(/[\s()-]/g, '');
    if (normalized.length > 40) throw new BadRequestException(`${label}过长`);
    return normalized;
  }

  private normalizeRevealReason(value: unknown) {
    const reason = this.normalizeNullableString(value);
    if (!reason) throw new BadRequestException('查看原因不能为空');
    if (reason.length > 200) throw new BadRequestException('查看原因过长');
    return reason;
  }

  private assertContactPermission(operator?: AuthenticatedUser) {
    if (
      operator &&
      (operator.roles.includes('admin') || operator.permissions.includes('customer.view_phone'))
    ) {
      return;
    }
    throw new ForbiddenException('无权查看完整联系电话');
  }

  private maskPhone(value: string | null) {
    if (!value) return null;
    if (value.length <= 4) return '****';
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }

  private toResponse(customer: CustomerWithRelations) {
    return {
      id: customer.id,
      name: customer.name,
      maskedPhone: customer.phoneMasked,
      phoneTail: customer.phoneTail,
      hasPhone: Boolean(customer.phoneEncrypted),
      wechat: customer.wechat,
      qq: customer.qq,
      maskedWhatsapp: customer.whatsappMasked,
      whatsappTail: customer.whatsappTail,
      hasWhatsapp: Boolean(customer.whatsappEncrypted),
      sourceOptionId: customer.sourceOptionId,
      source: customer.sourceOption,
      tagOptionIds: customer.tags.map((item) => item.optionId),
      tags: customer.tags.map((item) => item.option),
      serviceOptionIds: customer.services.map((item) => item.optionId),
      services: customer.services.map((item) => ({
        ...item.option,
        firstOpenedAt: item.firstOpenedAt!,
        lastOpenedAt: item.lastOpenedAt!,
        activationCount: item.activationCount
      })),
      recordStatus: customer.recordStatus,
      remark: customer.remark,
      createdBy: customer.createdBy,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt
    };
  }

  private revealSensitiveContact(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    field: 'phone' | 'whatsapp',
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    this.assertContactPermission(operator);
    const reason = this.normalizeRevealReason(dto.reason);
    return this.transactionManager.execute(
      async (tx, context) => {
        const customer = await this.findCustomerOrThrowInTransaction(tx, id);
        const encryptedValue =
          field === 'phone' ? customer.phoneEncrypted : customer.whatsappEncrypted;
        const value = this.fieldEncryptionService.decrypt(encryptedValue);
        const label = field === 'phone' ? '手机号' : 'WhatsApp';
        if (!value) throw new NotFoundException(`该客户没有${label}`);

        const approved = await this.repository.verifySensitiveAccessApproval(tx, {
          approvalId: dto.approvalId,
          requesterId: operator?.id,
          module: 'id_business_v2_customer',
          fieldName: field,
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          now: context.businessTime
        });
        await this.repository.appendSensitiveAccess(tx, {
          userId: operator?.id,
          fieldName: field,
          objectId: customer.id,
          accessReason: reason,
          approved,
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined
        });
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_customers',
          action: `id_business_v2.customer.${field}.reveal`,
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          afterData: toV2JsonDocument({
            field,
            reason,
            approved,
            contactTail: field === 'phone' ? customer.phoneTail : customer.whatsappTail
          }),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `查看 V2 客户${label}：${customer.name}`
        });
        return { customerId: customer.id, value, revealedAt: context.businessTime.toISOString() };
      },
      { requestId: requestMeta.requestId ?? randomUUID(), operator }
    );
  }
}
