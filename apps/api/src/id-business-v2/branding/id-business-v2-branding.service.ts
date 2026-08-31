import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  V2_BRANDING_DEFAULTS,
  V2_BRANDING_LIMITS,
  type UpdateV2BrandingSettingsInput
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  runV2OptimisticUpdate,
  toV2JsonDocument
} from '../runtime/public-api';
import type { UpdateIdBusinessV2BrandingSettingsDto } from './dto/update-id-business-v2-branding-settings.dto';
import { IdBusinessV2BrandingRepository } from './persistence/id-business-v2-branding.repository';

const MAX_HERO_LINES = 3;

@Injectable()
export class IdBusinessV2BrandingService {
  constructor(
    private readonly repository: IdBusinessV2BrandingRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async get() {
    const settings = await this.ensureSettings();
    return this.toResponse(settings);
  }

  async update(
    dto: UpdateIdBusinessV2BrandingSettingsDto,
    operator?: AuthenticatedUser,
    requestId = 'branding-settings-update'
  ) {
    if (!operator?.id) {
      throw new BadRequestException('无法识别当前操作人');
    }

    const input = this.normalizeUpdateInput(dto);
    const expectedUpdatedAt = normalizeV2ExpectedUpdatedAt(dto.expectedUpdatedAt, '品牌设置');
    const updated = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findSettings(tx);
        if (!before) {
          throw new ServiceUnavailableException('品牌设置尚未初始化，请刷新后重试');
        }
        assertV2ExpectedUpdatedAt(before.updatedAt, expectedUpdatedAt, '品牌设置');
        const row = await runV2OptimisticUpdate('品牌设置', () =>
          this.repository.updateSettings(tx, expectedUpdatedAt, {
            ...input,
            updatedByUserId: operator.id
          })
        );
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.branding.settings.update',
          objectType: 'id_business_v2_branding_settings',
          beforeData: before ? toV2JsonDocument(this.toAuditSnapshot(before)) : undefined,
          afterData: toV2JsonDocument(this.toAuditSnapshot(row)),
          remark: 'V2 品牌与登录页设置已保存'
        });
        return row;
      },
      { changedScopes: ['branding'], requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(updated);
  }

  private async ensureSettings() {
    const existing = await this.repository.findSettings();
    if (existing) return existing;

    try {
      return await this.transactionManager.execute(
        async (tx) => {
          const row = await this.repository.createDefaultSettings(tx, V2_BRANDING_DEFAULTS);
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.branding.settings.initialize',
            objectType: 'id_business_v2_branding_settings',
            afterData: toV2JsonDocument(this.toAuditSnapshot(row)),
            remark: 'V2 品牌与登录页设置初始化'
          });
          return row;
        },
        {
          changedScopes: ['branding'],
          requestId: 'branding-settings-initialize',
          retryMode: 'none'
        }
      );
    } catch {
      const raced = await this.repository.findSettings();
      if (raced) return raced;
      throw new ServiceUnavailableException('品牌设置暂时无法初始化');
    }
  }

  private normalizeUpdateInput(
    dto: UpdateIdBusinessV2BrandingSettingsDto
  ): UpdateV2BrandingSettingsInput {
    const appName = this.normalizePlainText(dto.appName, '软件名称', V2_BRANDING_LIMITS.appName);
    const logoText = this.normalizePlainText(
      dto.logoText,
      'Logo 文字',
      V2_BRANDING_LIMITS.logoText
    );
    const logoUrl = this.normalizeLogoUrl(dto.logoUrl);
    const appSubtitle = this.normalizePlainText(
      dto.appSubtitle,
      '品牌副标题',
      V2_BRANDING_LIMITS.appSubtitle
    );
    const loginHeroTitle = this.normalizeHeroTitle(dto.loginHeroTitle);
    const loginNote = this.normalizePlainText(
      dto.loginNote,
      '登录说明',
      V2_BRANDING_LIMITS.loginNote
    );
    const footerText = this.normalizePlainText(
      dto.footerText,
      '页脚文字',
      V2_BRANDING_LIMITS.footerText
    );
    const documentTitleSuffix = this.normalizePlainText(
      dto.documentTitleSuffix,
      '浏览器标题后缀',
      V2_BRANDING_LIMITS.documentTitleSuffix
    );

    return {
      appName,
      logoText,
      logoUrl,
      appSubtitle,
      loginHeroTitle,
      loginNote,
      footerText,
      documentTitleSuffix
    };
  }

  private normalizePlainText(value: unknown, label: string, maxLength: number) {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label}必须是文本`);
    }
    const normalized = this.replaceControlCharacters(value).replace(/\s+/g, ' ').trim();
    if (!normalized) {
      throw new BadRequestException(`请填写${label}`);
    }
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    }
    return normalized;
  }

  private normalizeLogoUrl(value: unknown) {
    const normalized = this.normalizePlainText(value, 'Logo 图片地址', V2_BRANDING_LIMITS.logoUrl);
    if (normalized.startsWith('/') && !normalized.startsWith('//')) return normalized;
    if (/^https?:\/\/[^\s]+$/i.test(normalized)) return normalized;
    throw new BadRequestException('Logo 图片地址必须是站内路径或 http(s) 链接');
  }

  private normalizeHeroTitle(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('登录主标题必须是文本');
    }
    const lines = this.replaceControlCharacters(value.replace(/\r/g, '\n'), true)
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trim())
      .filter(Boolean);
    if (!lines.length) {
      throw new BadRequestException('请填写登录主标题');
    }
    if (lines.length > MAX_HERO_LINES) {
      throw new BadRequestException(`登录主标题最多 ${MAX_HERO_LINES} 行`);
    }
    const normalized = lines.join('\n');
    if (normalized.length > V2_BRANDING_LIMITS.loginHeroTitle) {
      throw new BadRequestException(
        `登录主标题不能超过 ${V2_BRANDING_LIMITS.loginHeroTitle} 个字符`
      );
    }
    return normalized;
  }

  private replaceControlCharacters(value: string, allowLineBreaks = false) {
    return Array.from(value)
      .map((char) => {
        if (allowLineBreaks && char === '\n') return char;
        const code = char.charCodeAt(0);
        return code < 32 || code === 127 ? ' ' : char;
      })
      .join('');
  }

  private toResponse(settings: {
    appName: string;
    logoText: string;
    logoUrl: string;
    appSubtitle: string;
    loginHeroTitle: string;
    loginNote: string;
    footerText: string;
    documentTitleSuffix: string;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      appName: settings.appName,
      logoText: settings.logoText,
      logoUrl: settings.logoUrl,
      appSubtitle: settings.appSubtitle,
      loginHeroTitle: settings.loginHeroTitle,
      loginNote: settings.loginNote,
      footerText: settings.footerText,
      documentTitleSuffix: settings.documentTitleSuffix,
      updatedByUserId: settings.updatedByUserId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt
    };
  }

  private toAuditSnapshot(settings: {
    appName: string;
    logoText: string;
    logoUrl: string;
    appSubtitle: string;
    loginHeroTitle: string;
    loginNote: string;
    footerText: string;
    documentTitleSuffix: string;
    updatedByUserId: string | null;
  }) {
    return {
      appName: settings.appName,
      logoText: settings.logoText,
      logoUrl: settings.logoUrl,
      appSubtitle: settings.appSubtitle,
      loginHeroTitle: settings.loginHeroTitle,
      loginNote: settings.loginNote,
      footerText: settings.footerText,
      documentTitleSuffix: settings.documentTitleSuffix,
      updatedByUserId: settings.updatedByUserId
    };
  }
}
