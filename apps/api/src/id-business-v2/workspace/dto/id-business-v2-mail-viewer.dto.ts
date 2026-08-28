export interface QueryIdBusinessV2MailViewerDto {
  queryCode?: unknown;
  /** 兼容旧版“邮箱----查询码”请求，前端不再发送。 */
  credential?: unknown;
  limit?: unknown;
}
