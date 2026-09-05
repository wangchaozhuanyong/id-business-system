import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { IdBusinessV2MicrosoftMailboxAuthorizationService } from './id-business-v2-microsoft-mailbox-authorization.service';

@Controller('public/mailbox/microsoft-oauth')
export class IdBusinessV2MicrosoftMailboxOAuthController {
  constructor(private readonly authorization: IdBusinessV2MicrosoftMailboxAuthorizationService) {}

  @Get('callback')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @SkipApiResponse()
  async callback(@Query() query: { code?: unknown; error?: unknown; state?: unknown }) {
    const result = await this.authorization
      .complete(query)
      .catch(() => ({ succeeded: false as const, failureCode: 'invalid_state' as const }));
    const mailboxConnectionFailed =
      !result.succeeded && result.failureCode === 'mailbox_auth_failed';
    const title = result.succeeded
      ? 'Microsoft 邮箱授权完成'
      : mailboxConnectionFailed
        ? 'Microsoft 邮箱连接失败'
        : 'Microsoft 邮箱授权失败';
    const detail = result.succeeded
      ? '邮箱已加入邮箱池，可以关闭此窗口。'
      : this.failureDetail(result.failureCode);
    const settingsLink = mailboxConnectionFailed
      ? '<p><a href="https://outlook.live.com/mail/0/options/mail/forwarding" target="_blank" rel="noopener noreferrer">打开 Outlook 的 IMAP 设置</a></p><p>如果设置页要求验证身份，请先在该页面点击“登录”完成验证，再开启“允许设备和应用使用 IMAP”并保存。回到邮箱池后重新连接。</p>'
      : '';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:40px;color:#182230;line-height:1.6"><h1 style="font-size:20px">${title}</h1><p>${detail}</p>${settingsLink}</body></html>`;
  }

  private failureDetail(code: string | undefined) {
    switch (code) {
      case 'mailbox_auth_failed':
        return 'Microsoft 已返回授权，但邮箱服务器拒绝了连接。请核对授权账号是否与填写的邮箱一致，并检查 Outlook 的 IMAP 是否开启。只反复点击授权无法解决邮箱连接问题。';
      case 'invalid_state':
        return '此授权链接已失效或已处理。请关闭窗口，从邮箱池重新点击“连接 Microsoft 并添加”，不要刷新或重复打开旧的回调链接。';
      case 'consent_denied':
        return '尚未完成 Microsoft 授权。请关闭窗口，重新连接并在 Microsoft 页面完成授权。';
      case 'configuration_missing':
        return '系统尚未配置 Microsoft 邮箱授权，请联系管理员检查配置后再连接。';
      case 'provider_unavailable':
        return 'Microsoft 授权或邮箱服务暂时不可用，请稍后从邮箱池重新连接。';
      case 'email_exists':
        return '该邮箱已经加入邮箱池。请关闭窗口并刷新邮箱列表。';
      case 'authorization_failed':
        return 'Microsoft 授权未能完成，请从邮箱池重新连接；若仍失败，请联系管理员检查授权配置。';
      default:
        return '保存邮箱授权未能完成，请联系管理员检查后再连接。';
    }
  }
}
