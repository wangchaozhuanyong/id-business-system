import { Injectable } from '@nestjs/common';
import type { OnlineRechargeSecurityNotification } from '../security-notification.service';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeSettingsService } from '../settings.service';

@Injectable()
export class OnlineRechargeSecurityNotificationRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly settings: OnlineRechargeSettingsService
  ) {}
  async enqueue(input: OnlineRechargeSecurityNotification): Promise<void> {
    const { settings: s, secrets } = await this.settings.internal();
    const hasTarget =
      (s.telegramAdminEnabled && secrets.telegramAdminChatId) ||
      (s.telegramGroupEnabled && secrets.telegramGroupChatId);
    if (!s.telegramEnabled || !s.telegramOnAdminLogin || !secrets.telegramBotToken || !hasTarget)
      return;
    await this.repository.transaction('security-notifications', async (tx) => {
      const dedupeKey = `security-login:${input.loginAttemptId}`;
      if (await tx.onlineRechargeEvent.findUnique({ where: { dedupeKey } })) return;
      const task = await tx.onlineRechargeTask.create({
        data: {
          operation: 'notification',
          message: '管理员安全事件通知待执行',
          operatorId: input.userId,
          payload: { event: input.event, ...(input.maskedIp ? { maskedIp: input.maskedIp } : {}) }
        }
      });
      await tx.onlineRechargeEvent.create({
        data: {
          taskId: task.id,
          dedupeKey,
          stage: 'security_notification',
          message: '安全通知已排队',
          metadata: { event: input.event }
        }
      });
      await this.repository.log(tx, 'security_notification.enqueue', undefined, task.id, {
        event: input.event
      });
    });
  }
}
