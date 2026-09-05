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
    const succeeded = await this.authorization
      .complete(query)
      .then((result) => result.succeeded)
      .catch(() => false);
    const title = succeeded ? 'Microsoft 邮箱授权完成' : 'Microsoft 邮箱授权失败';
    const detail = succeeded ? '邮箱已加入邮箱池，可以关闭此窗口。' : '请关闭窗口后重新发起授权。';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:40px;color:#182230"><h1 style="font-size:20px">${title}</h1><p>${detail}</p></body></html>`;
  }
}
