import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2OptionsService } from '../options/public-api';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  buildIdBusinessV2BlindIndexTokens,
  buildIdBusinessV2BlindQueryTokens,
  createV2DeletePreviewFingerprint,
  normalizeV2DeletePreviewFingerprint,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
import {
  maskIdBusinessV2CustomerContact,
  maskIdBusinessV2CustomerPhone,
  toIdBusinessV2CustomerResponse,
  type IdBusinessV2CustomerContactField
} from './id-business-v2-customer-presentation';
import type {
  IdBusinessV2CustomerAuditRequestMeta,
  IdBusinessV2CustomerRecordStatus,
  ListIdBusinessV2CustomersQuery
} from './id-business-v2-customers.types';
import type { CreateIdBusinessV2CustomerDto } from './dto/create-id-business-v2-customer.dto';
import type { RevealIdBusinessV2CustomerPhoneDto } from './dto/reveal-id-business-v2-customer-phone.dto';
import type { UpdateIdBusinessV2CustomerDto } from './dto/update-id-business-v2-customer.dto';
import {
  IdBusinessV2CustomerRepository,
  type CustomerWithRelations,
  type UpdateCustomerPersistenceInput
} from './persistence/id-business-v2-customer.repository';

@Injectable()
export class IdBusinessV2CustomersService {
  constructor(
    private readonly repository: IdBusinessV2CustomerRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {}

  async list(query: ListIdBusinessV2CustomersQuery, operator?: AuthenticatedUser) {
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
      phoneSearchTokens: buildIdBusinessV2BlindQueryTokens(
        contactKeyword,
        'customer-phone',
        (value) => this.fieldEncryptionService.hash(value)
      ),
      wechatSearchTokens: buildIdBusinessV2BlindQueryTokens(keyword, 'customer-wechat', (value) =>
        this.fieldEncryptionService.hash(value)
      ),
      qqSearchTokens: buildIdBusinessV2BlindQueryTokens(keyword, 'customer-qq', (value) =>
        this.fieldEncryptionService.hash(value)
      ),
      whatsappSearchTokens: buildIdBusinessV2BlindQueryTokens(
        contactKeyword,
        'customer-whatsapp',
        (value) => this.fieldEncryptionService.hash(value)
      ),
      sourceOptionId: this.normalizeNullableString(query.sourceOptionId),
      tagOptionId: query.tagOptionId,
      serviceOptionId: query.serviceOptionId,
      recordStatus: this.parseRecordStatus(query.recordStatus, false),
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    });
    return { ...result, items: await this.presentCustomers(result.items, operator) };
  }

  async get(id: string, operator?: AuthenticatedUser) {
    return (await this.presentCustomers([await this.findCustomerOrThrow(id)], operator))[0];
  }

  async getDeletePreview(id: string) {
    const customer = await this.findCustomerOrThrow(id);
    const impact = await this.repository.getDeleteImpact(customer.id);
    return this.buildDeletePreview(customer, impact);
  }

  create(
    dto: CreateIdBusinessV2CustomerDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const name = this.normalizeRequiredString(dto.name, '客户名称');
        const phone = this.normalizePhone(dto.phone, '手机号');
        const whatsapp = this.normalizePhone(dto.whatsapp, 'WhatsApp');
        const wechat = this.normalizeOptionalText(dto.wechat, '微信', 120);
        const qq = this.normalizeOptionalText(dto.qq, 'QQ', 120);
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
          phoneMasked: maskIdBusinessV2CustomerPhone(phone),
          phoneTail: phone ? phone.slice(-8) : null,
          phoneSearchTokens: this.buildContactSearchTokens(phone, 'customer-phone'),
          wechat: null,
          wechatEncrypted: this.fieldEncryptionService.encrypt(wechat),
          wechatHash: this.fieldEncryptionService.hash(wechat),
          wechatMasked: maskIdBusinessV2CustomerContact(wechat),
          wechatSearchTokens: this.buildContactSearchTokens(wechat, 'customer-wechat'),
          qq: null,
          qqEncrypted: this.fieldEncryptionService.encrypt(qq),
          qqHash: this.fieldEncryptionService.hash(qq),
          qqMasked: maskIdBusinessV2CustomerContact(qq),
          qqSearchTokens: this.buildContactSearchTokens(qq, 'customer-qq'),
          whatsappEncrypted: this.fieldEncryptionService.encrypt(whatsapp),
          whatsappHash: this.fieldEncryptionService.hash(whatsapp),
          whatsappMasked: maskIdBusinessV2CustomerPhone(whatsapp),
          whatsappTail: whatsapp ? whatsapp.slice(-8) : null,
          whatsappSearchTokens: this.buildContactSearchTokens(whatsapp, 'customer-whatsapp'),
          sourceOptionId: sourceOption?.id ?? null,
          recordStatus: this.parseRecordStatus(dto.recordStatus, false) ?? 'active',
          remark: this.normalizeNullableString(dto.remark),
          tagOptionIds: tags.map((tag) => tag.id),
          operatorId: operator?.id
        });
        const response = toIdBusinessV2CustomerResponse(customer);
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
      this.commandOptions('customers', requestMeta, operator)
    );
  }

  update(
    id: string,
    dto: UpdateIdBusinessV2CustomerDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.findCustomerOrThrowInTransaction(tx, id);
        const phone =
          dto.phone === undefined ? undefined : this.normalizePhone(dto.phone, '手机号');
        const whatsapp =
          dto.whatsapp === undefined ? undefined : this.normalizePhone(dto.whatsapp, 'WhatsApp');
        const wechat =
          dto.wechat === undefined
            ? undefined
            : this.normalizeOptionalText(dto.wechat, '微信', 120);
        const qq = dto.qq === undefined ? undefined : this.normalizeOptionalText(dto.qq, 'QQ', 120);
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
          phoneMasked: phone === undefined ? undefined : maskIdBusinessV2CustomerPhone(phone),
          phoneTail: phone === undefined ? undefined : (phone?.slice(-8) ?? null),
          phoneSearchTokens:
            phone === undefined
              ? undefined
              : this.buildContactSearchTokens(phone, 'customer-phone'),
          wechat: wechat === undefined ? undefined : null,
          wechatEncrypted:
            wechat === undefined ? undefined : this.fieldEncryptionService.encrypt(wechat),
          wechatHash: wechat === undefined ? undefined : this.fieldEncryptionService.hash(wechat),
          wechatMasked: wechat === undefined ? undefined : maskIdBusinessV2CustomerContact(wechat),
          wechatSearchTokens:
            wechat === undefined
              ? undefined
              : this.buildContactSearchTokens(wechat, 'customer-wechat'),
          qq: qq === undefined ? undefined : null,
          qqEncrypted: qq === undefined ? undefined : this.fieldEncryptionService.encrypt(qq),
          qqHash: qq === undefined ? undefined : this.fieldEncryptionService.hash(qq),
          qqMasked: qq === undefined ? undefined : maskIdBusinessV2CustomerContact(qq),
          qqSearchTokens:
            qq === undefined ? undefined : this.buildContactSearchTokens(qq, 'customer-qq'),
          whatsappEncrypted:
            whatsapp === undefined ? undefined : this.fieldEncryptionService.encrypt(whatsapp),
          whatsappHash:
            whatsapp === undefined ? undefined : this.fieldEncryptionService.hash(whatsapp),
          whatsappMasked:
            whatsapp === undefined ? undefined : maskIdBusinessV2CustomerPhone(whatsapp),
          whatsappTail: whatsapp === undefined ? undefined : (whatsapp?.slice(-8) ?? null),
          whatsappSearchTokens:
            whatsapp === undefined
              ? undefined
              : this.buildContactSearchTokens(whatsapp, 'customer-whatsapp'),
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
        const response = toIdBusinessV2CustomerResponse(customer);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_customers',
          action: 'id_business_v2.customer.update',
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          beforeData: toV2JsonDocument(toIdBusinessV2CustomerResponse(existing)),
          afterData: toV2JsonDocument(response),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `修改 V2 客户：${existing.name}`
        });
        return response;
      },
      this.commandOptions('customers', requestMeta, operator)
    );
  }

  remove(
    id: string,
    previewFingerprintValue: string | undefined,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    const previewFingerprint = normalizeV2DeletePreviewFingerprint(previewFingerprintValue);
    return this.transactionManager.execute(
      async (tx, context) => {
        const existing = await this.findCustomerOrThrowInTransaction(tx, id);
        const impact = await this.repository.getDeleteImpact(existing.id, tx);
        const preview = this.buildDeletePreview(existing, impact);
        if (preview.fingerprint !== previewFingerprint) {
          throw new ConflictException('删除依赖已经变化，请重新预览后再确认');
        }
        if (!preview.canDelete) {
          throw new BadRequestException(preview.blockingReasons.join('；'));
        }
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
          beforeData: toV2JsonDocument(toIdBusinessV2CustomerResponse(existing)),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `删除 V2 客户：${existing.name}`
        });
        return { deleted: true };
      },
      this.commandOptions('customers', requestMeta, operator)
    );
  }

  private buildDeletePreview(
    customer: CustomerWithRelations,
    impact: Awaited<ReturnType<IdBusinessV2CustomerRepository['getDeleteImpact']>>
  ) {
    const blockingReasons: string[] = [];
    if (impact.activeOrderCount > 0) {
      blockingReasons.push(`仍有 ${impact.activeOrderCount} 个进行中订单，不能删除客户`);
    }
    if (impact.activeActivationCount > 0) {
      blockingReasons.push(`仍有 ${impact.activeActivationCount} 个活动开通记录，不能删除客户`);
    }
    return {
      entityId: customer.id,
      entityName: customer.name,
      canDelete: blockingReasons.length === 0,
      blockingReasons,
      impact,
      fingerprint: createV2DeletePreviewFingerprint(
        'customer',
        customer.id,
        customer.updatedAt,
        impact
      )
    };
  }

  async revealPhone(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'phone', operator, requestMeta);
    return { customerId: result.customerId, phone: result.value, revealedAt: result.revealedAt };
  }

  async revealWhatsapp(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'whatsapp', operator, requestMeta);
    return { customerId: result.customerId, whatsapp: result.value, revealedAt: result.revealedAt };
  }

  async revealWechat(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'wechat', operator, requestMeta);
    return { customerId: result.customerId, wechat: result.value, revealedAt: result.revealedAt };
  }

  async revealQq(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    const result = await this.revealSensitiveContact(id, dto, 'qq', operator, requestMeta);
    return { customerId: result.customerId, qq: result.value, revealedAt: result.revealedAt };
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

  private parseRecordStatus(
    value: unknown,
    required: boolean
  ): IdBusinessV2CustomerRecordStatus | null {
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

  private normalizeRevealReason(value: unknown, fallback?: string) {
    const reason = this.normalizeNullableString(value);
    if (!reason && fallback) return fallback;
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

  private buildContactSearchTokens(
    value: string | null,
    namespace: 'customer-phone' | 'customer-wechat' | 'customer-qq' | 'customer-whatsapp'
  ) {
    return buildIdBusinessV2BlindIndexTokens(value, namespace, (item) =>
      this.fieldEncryptionService.hash(item)
    );
  }

  private contactValue(customer: CustomerWithRelations, field: IdBusinessV2CustomerContactField) {
    if (field === 'phone') return this.fieldEncryptionService.decrypt(customer.phoneEncrypted);
    if (field === 'whatsapp') {
      return this.fieldEncryptionService.decrypt(customer.whatsappEncrypted);
    }
    if (field === 'wechat') {
      return this.fieldEncryptionService.decrypt(customer.wechatEncrypted) ?? customer.wechat;
    }
    return this.fieldEncryptionService.decrypt(customer.qqEncrypted) ?? customer.qq;
  }

  private async presentCustomers(customers: CustomerWithRelations[], operator?: AuthenticatedUser) {
    if (!operator) return customers.map((customer) => toIdBusinessV2CustomerResponse(customer));
    const modes = await this.sensitiveAccessService.resolveDisplayModes(
      operator,
      ['customer.phone', 'customer.wechat', 'customer.qq', 'customer.whatsapp'],
      'customer_management'
    );
    const value = (
      customer: CustomerWithRelations,
      field: IdBusinessV2CustomerContactField,
      masked: string | null
    ) => {
      const mode = modes[`customer.${field}`];
      if (mode === 'hidden') return null;
      return mode === 'full' ? this.contactValue(customer, field) : masked;
    };
    return customers.map((customer) =>
      toIdBusinessV2CustomerResponse(customer, {
        phone: value(customer, 'phone', customer.phoneMasked),
        wechat: value(
          customer,
          'wechat',
          customer.wechatMasked ?? maskIdBusinessV2CustomerContact(customer.wechat)
        ),
        qq: value(
          customer,
          'qq',
          customer.qqMasked ?? maskIdBusinessV2CustomerContact(customer.qq)
        ),
        whatsapp: value(customer, 'whatsapp', customer.whatsappMasked),
        modes: {
          phone: modes['customer.phone'],
          wechat: modes['customer.wechat'],
          qq: modes['customer.qq'],
          whatsapp: modes['customer.whatsapp']
        }
      })
    );
  }

  private revealSensitiveContact(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    field: IdBusinessV2CustomerContactField,
    operator?: AuthenticatedUser,
    requestMeta: IdBusinessV2CustomerAuditRequestMeta = {}
  ) {
    this.assertContactPermission(operator);
    return this.transactionManager.execute(
      async (tx, context) => {
        const customer = await this.findCustomerOrThrowInTransaction(tx, id);
        const label =
          field === 'phone'
            ? '手机号'
            : field === 'wechat'
              ? '微信'
              : field === 'qq'
                ? 'QQ'
                : 'WhatsApp';
        const access = await this.sensitiveAccessService.authorize(tx, {
          approvalId: dto.approvalId,
          module: 'id_business_v2_customer',
          fieldName: field,
          objectType: 'id_business_v2_customer',
          objectId: customer.id,
          operator,
          now: context.businessTime
        });
        const reason =
          access.mode === 'approval'
            ? access.reason
            : this.normalizeRevealReason(dto.reason, access.reason);
        const value = this.contactValue(customer, field);
        if (!value) throw new NotFoundException(`该客户没有${label}`);
        await this.repository.appendSensitiveAccess(tx, {
          userId: operator?.id,
          fieldName: field,
          objectId: customer.id,
          accessReason: reason,
          approved: true,
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
            approved: true,
            accessMode: access.mode,
            approvalId: access.approvalId,
            contactTail:
              field === 'phone'
                ? customer.phoneTail
                : field === 'whatsapp'
                  ? customer.whatsappTail
                  : null
          }),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `查看 V2 客户${label}：${customer.name}`
        });
        return { customerId: customer.id, value, revealedAt: context.businessTime.toISOString() };
      },
      this.commandOptions('security', requestMeta, operator)
    );
  }

  private commandOptions(
    scope: 'customers' | 'security',
    requestMeta: IdBusinessV2CustomerAuditRequestMeta,
    operator?: AuthenticatedUser
  ) {
    return { changedScopes: [scope], requestId: requestMeta.requestId ?? randomUUID(), operator };
  }
}
