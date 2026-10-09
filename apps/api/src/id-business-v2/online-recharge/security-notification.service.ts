import { BadRequestException, Injectable } from '@nestjs/common';
import { OnlineRechargeSecurityNotificationRepository } from './persistence/security-notification.repository';
import { text } from './validation';

export type OnlineRechargeSecurityEvent =
  | 'admin_login_success'
  | 'admin_login_failed'
  | 'admin_2fa_failed';
export interface OnlineRechargeSecurityNotification {
  event: OnlineRechargeSecurityEvent;
  loginAttemptId: string;
  userId?: string;
  maskedIp?: string;
}

@Injectable()
export class OnlineRechargeSecurityNotificationService {
  constructor(private readonly notifications: OnlineRechargeSecurityNotificationRepository) {}
  async enqueue(input: OnlineRechargeSecurityNotification): Promise<void> {
    if (!['admin_login_success', 'admin_login_failed', 'admin_2fa_failed'].includes(input.event))
      throw new BadRequestException('安全通知事件无效');
    const loginAttemptId = text(input.loginAttemptId, '登录事件编号', 100);
    const maskedIp = input.maskedIp ? text(input.maskedIp, '脱敏来源', 100) : undefined;
    // 来自共享身份审计桥。禁止持久化真实IP、账号、UA、密码、验证码或会话。
    if (maskedIp && !maskedIp.includes('*') && !maskedIp.includes('…') && maskedIp !== '已脱敏')
      throw new BadRequestException('安全通知仅接受脱敏来源');
    await this.notifications.enqueue({
      event: input.event,
      loginAttemptId,
      userId: input.userId,
      maskedIp
    });
  }
}
