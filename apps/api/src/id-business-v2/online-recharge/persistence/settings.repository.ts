import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { ONLINE_RECHARGE_DEFAULTS, ONLINE_RECHARGE_SECRET_KEYS } from '../contracts';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { integer, object, text } from '../validation';

@Injectable()
export class OnlineRechargeSettingsRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly encryption: FieldEncryptionService
  ) {}
  async internal() {
    const row = await this.repository.read((db) =>
      db.onlineRechargeConfig.findUnique({ where: { id: 'global' } })
    );
    const settings = {
      ...ONLINE_RECHARGE_DEFAULTS,
      ...(row ? object(row.settings) : {})
    } as Record<string, unknown>;
    const secrets: Record<string, string> = row?.secretsEncrypted
      ? JSON.parse(this.encryption.decrypt(row.secretsEncrypted)!)
      : {};
    return { settings, secrets, version: row?.version ?? 0 };
  }
  async get(): Promise<
    Record<string, unknown> & { version: number; secretStatus: Record<string, boolean> }
  > {
    const { settings, secrets, version } = await this.internal();
    const draining =
      settings.maintenance === true &&
      (await this.repository.read((db) =>
        db.onlineRechargeTask.count({
          where: {
            operation: 'recharge',
            status: { in: ['queued', 'running', 'awaiting_credentials'] }
          }
        })
      )) > 0;
    return {
      ...settings,
      version,
      maintenanceDrain: draining,
      secretStatus: Object.fromEntries(
        ONLINE_RECHARGE_SECRET_KEYS.map((key) => [key, Boolean(secrets[key])])
      )
    };
  }
  async update(inputValue: unknown, operator: AuthenticatedUser) {
    const input = object(inputValue);
    const allowed = new Set<string>([
      ...Object.keys(ONLINE_RECHARGE_DEFAULTS),
      ...ONLINE_RECHARGE_SECRET_KEYS,
      'version'
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new BadRequestException('设置包含不支持的字段');
    await this.repository.transaction('config', async (tx) => {
      const existing = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
      if (input.version !== undefined && input.version !== (existing?.version ?? 0))
        throw new ConflictException('设置已变化，请刷新后重试');
      const settings: Record<string, unknown> = {
        ...ONLINE_RECHARGE_DEFAULTS,
        ...(existing ? object(existing.settings) : {})
      };
      const secrets: Record<string, string> = existing?.secretsEncrypted
        ? JSON.parse(this.encryption.decrypt(existing.secretsEncrypted)!)
        : {};
      for (const key of ONLINE_RECHARGE_SECRET_KEYS)
        if (input[key] !== undefined && input[key] !== '')
          secrets[key] = text(input[key], '配置凭据', 4096, false);
      if (!secrets.externalCardsApiKey)
        secrets.externalCardsApiKey = randomBytes(32).toString('base64url');
      for (const [key, defaultValue] of Object.entries(ONLINE_RECHARGE_DEFAULTS)) {
        if (input[key] === undefined) continue;
        if (typeof defaultValue === 'boolean') {
          if (typeof input[key] !== 'boolean') throw new BadRequestException('开关设置格式无效');
          settings[key] = input[key];
        } else if (typeof defaultValue === 'number')
          settings[key] = integer(
            input[key],
            '配置数值',
            1,
            /TimeoutMs$/.test(key) ? 600000 : key === 'cdpPort' ? 65535 : 100
          );
        else settings[key] = text(input[key], '配置内容', 2048, defaultValue !== '');
      }
      if (!['US', 'PH', 'SG', 'MY'].includes(String(settings.paymentRegion)))
        throw new BadRequestException('支付地区无效');
      if (!['pool', 'standalone'].includes(String(settings.browserMode)))
        throw new BadRequestException('浏览器模式无效');
      for (const key of ['planNamePlus', 'planNamePro5x', 'planNamePro20x'] as const)
        if (settings[key] !== ONLINE_RECHARGE_DEFAULTS[key])
          throw new BadRequestException(
            '充值套餐映射必须保持原版，调试套餐标识请在支付链接调试中填写'
          );
      for (const key of ['gptApiBaseUrl', 'captchaPlatformBaseUrl', 'vlmBaseUrl']) {
        if (!settings[key]) continue;
        let url: URL;
        try {
          url = new URL(String(settings[key]));
        } catch {
          throw new BadRequestException('接口地址无效');
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new BadRequestException('接口地址仅支持HTTP且不得包含凭据');
      }
      const data = {
        settings: settings as Prisma.InputJsonObject,
        secretsEncrypted: this.encryption.encrypt(JSON.stringify(secrets)),
        version: (existing?.version ?? 0) + 1
      };
      await tx.onlineRechargeConfig.upsert({
        where: { id: 'global' },
        create: { id: 'global', ...data },
        update: data
      });
      const cap = Number(settings.cardMaxSubscriptionCount);
      await tx.onlineRechargeCard.updateMany({
        where: { successCount: { gte: cap }, status: 'active', leaseOwner: null },
        data: { status: 'exhausted' }
      });
      await tx.onlineRechargeCard.updateMany({
        where: { successCount: { lt: cap }, status: 'exhausted', leaseOwner: null },
        data: { status: 'active' }
      });
      await this.repository.log(tx, 'config.update', operator, undefined, {
        changedKeys: Object.keys(input).filter(
          (key) =>
            !ONLINE_RECHARGE_SECRET_KEYS.includes(
              key as (typeof ONLINE_RECHARGE_SECRET_KEYS)[number]
            )
        )
      });
    });
    return this.get();
  }
  async cardPolicy() {
    const { settings } = await this.internal();
    return {
      maxSubscriptionCount: Number(settings.cardMaxSubscriptionCount),
      maxDeclineCount: Number(settings.cardMaxDeclineCount)
    };
  }
  async runtime() {
    const { settings: s, secrets: k } = await this.internal();
    return {
      ...s,
      gptApi: {
        enabled: s.gptApiEnabled,
        base_url: s.gptApiBaseUrl,
        api_key: k.gptApiKey ?? '',
        plan_key: 'plus',
        country: s.paymentRegion,
        currency:
          s.paymentRegion === 'PH'
            ? 'PHP'
            : s.paymentRegion === 'MY'
              ? 'MYR'
              : s.paymentRegion === 'SG'
                ? 'SGD'
                : 'USD'
      },
      hcaptcha: {
        solver_enabled: s.hcaptchaEnabled,
        solver_no_vlm: s.hcaptchaDisableVlm,
        vlm_api_key: k.vlmApiKey ?? '',
        vlm_base_url: s.vlmBaseUrl,
        vlm_model: s.vlmModel,
        vlm_timeout: Number(s.vlmTimeoutMs) / 1000,
        solver_timeout: Number(s.hcaptchaSolverTimeoutMs) / 1000,
        cdp_port: s.cdpPort,
        platform_api_key: k.captchaPlatformApiKey ?? '',
        platform_api_url: s.captchaPlatformBaseUrl,
        platform_timeout: Number(s.captchaPlatformTimeoutMs) / 1000
      },
      browserPool: { enabled: s.browserMode === 'pool', size: s.browserPoolSize },
      telegram: {
        bot_token: k.telegramBotToken ?? '',
        admin_chat_id: k.telegramAdminChatId ?? '',
        group_chat_id: k.telegramGroupChatId ?? '',
        notify_admin: s.telegramEnabled && s.telegramAdminEnabled,
        notify_group: s.telegramEnabled && s.telegramGroupEnabled,
        on_success: s.telegramNotifySuccess,
        on_failure: s.telegramNotifyFailure,
        on_card_pool_empty: s.telegramNotifyCardEmpty,
        on_admin_login: s.telegramOnAdminLogin
      },
      maxProcessAttempts: 1,
      paymentMaxCardAttempts: Number(s.paymentMaxCardAttempts),
      checkoutMode: 'api',
      headful: true,
      region: s.paymentRegion,
      planNames: { plus: s.planNamePlus, pro_5x: s.planNamePro5x, pro_20x: s.planNamePro20x }
    };
  }
}
