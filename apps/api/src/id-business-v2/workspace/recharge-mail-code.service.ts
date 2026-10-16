import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';
import { assertRegistrationMailboxEmail } from './registration-mailbox-summaries';
import { registrationMail } from './registration-mail';
import { MailEventsService } from './mail-events.service';

@Injectable()
export class IdBusinessV2RechargeMailboxService {
  constructor(
    private readonly client: IdBusinessV2VendureMailboxClient,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly events: MailEventsService
  ) {}

  async rechargeMailbox(emailValue: string, operator: AuthenticatedUser) {
    // 复用管理员权限、唯一邮箱地址及买家查询授权校验；从不新建邮箱资料。
    const { aliasId } = await this.mailboxes.accountBuyerCode(emailValue, operator);
    const mailbox = await this.mailboxes.registrationMailbox(aliasId, operator);
    assertRegistrationMailboxEmail(mailbox.email, emailValue);
    return { aliasId, email: mailbox.email.trim().toLowerCase() };
  }

  async rechargeCode(
    aliasId: string,
    email: string,
    since: Date,
    previousId: string | null,
    operator: AuthenticatedUser
  ) {
    const mailbox = await this.mailboxes.registrationMailbox(aliasId, operator);
    assertRegistrationMailboxEmail(mailbox.email, email);
    const result = await this.client.publicQuery(mailbox.queryCode);
    if (!result.success) throw new ServiceUnavailableException('邮件查询暂时不可用，请重试');
    // 登录验证码框只接受数字；注册验证链接不能被当作验证码填入。
    return registrationMail(
      result.items.filter((mail) => /^\d{6,8}$/.test(mail.extractedCode ?? '')),
      mailbox.email,
      since,
      previousId,
      aliasId
    );
  }

  async waitForRechargeCode(
    aliasId: string,
    email: string,
    since: Date,
    operator: AuthenticatedUser
  ) {
    const deadline = Date.now() + 120_000;
    let changed = true;
    let wake: (() => void) | undefined;
    const unsubscribe = this.events.subscribe(async (receivedAliasId) => {
      if (receivedAliasId !== null && receivedAliasId !== aliasId) return;
      changed = true;
      wake?.();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      while (Date.now() < deadline) {
        if (changed) {
          changed = false;
          const mail = await this.rechargeCode(aliasId, email, since, null, operator);
          if (mail && /^\d{6,8}$/.test(mail.code)) return mail;
          if (changed) continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          if (changed) resolve();
        });
        if (timer) clearTimeout(timer);
        wake = undefined;
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  }
}
