# 受管邮箱运行说明

## 支持范围

- Gmail：`imap.gmail.com:993`，TLS。
- iCloud、me.com、mac.com：`imap.mail.me.com:993`，TLS。
- Microsoft Outlook/Hotmail：`outlook.office365.com:993`，TLS，使用官方 OAuth2。
- Gmail/iCloud 必须使用平台生成的应用专用密码，不能填写普通登录密码；Microsoft 不接收邮箱密码。
- 买家直接使用系统另行生成的查询码，该查询码不是邮箱密码；默认有效期为 30 天，管理员可在邮箱池全局设置为 1 至 365 天。

Google 账号需先开启两步验证后生成应用专用密码。部分组织账号、仅安全密钥两步验证或高级保护账号
可能不提供应用专用密码，此类账号后续应接入 Google OAuth，不能使用普通密码替代。Apple 账号需开启
双重认证并生成应用专用密码。

- Google 生成入口：<https://myaccount.google.com/apppasswords>
- Google 官方步骤：<https://support.google.com/accounts/answer/185833?hl=zh-Hans>
- Apple 账户入口：<https://account.apple.com/>（登录后进入“登录和安全 → App 专用密码”）
- Apple 官方步骤：<https://support.apple.com/zh-cn/102654>

应用专用密码通常只在生成时显示一次；已遗忘时应撤销旧密码并重新生成，不得改用邮箱普通登录密码。

Microsoft 邮箱需先在 Outlook 网页设置的“邮件 → 转发和 IMAP”中允许 IMAP，然后由管理员在邮箱池
点击“连接 Microsoft 并添加”完成授权。Microsoft 365 工作或学校账号还会受所在组织的应用同意策略约束。
批量导入 Microsoft 邮箱时不接收密码，系统复用一个授权窗口按录入顺序逐个完成 OAuth2；每个邮箱仍需
管理员选择对应 Microsoft 账号并确认授权。

iCloud IMAP 按 Apple 官方顺序优先使用邮箱名称部分作为用户名，授权失败时再尝试完整邮箱地址。Gmail 始终使用完整
邮箱地址。管理员添加邮箱或更新凭据时，瞬时网络连接失败只重试一次，授权失败不做网络重试。

## 本地运行

1. 配置项目现有 `DATABASE_URL`、`FIELD_ENCRYPTION_KEY` 和 `HASH_SECRET`。Microsoft 邮箱还需在
   Microsoft Entra 应用中登记回调地址，并配置 `MICROSOFT_MAIL_OAUTH_CLIENT_ID`、
   `MICROSOFT_MAIL_OAUTH_CLIENT_SECRET`、`MICROSOFT_MAIL_OAUTH_REDIRECT_URI`。
2. 执行 `npm run prisma:migrate:deploy --workspace @apple-business/api`。
3. 使用 `npm run dev:api` 启动 Node API，再使用 `npm run dev:admin` 启动管理端。
4. 管理员从个人工作区打开“邮件查看器”，在“邮箱池管理”中验证并添加邮箱。
5. 从邮箱池表格复制买家查询码并交付给买家；买家访问 `/mailbox` 查询。

应用专用密码、Microsoft OAuth2 令牌、买家查询码和邮件内容不得写入命令行、工单、日志或源码。
买家查询码使用字段级加密保存，只允许管理员通过禁止缓存的邮箱池接口完整查看和一键复制；公开查询仍只按
查询码 HMAC 定位邮箱。迁移前只保存 HMAC 的历史查询码无法恢复，管理员点击“生成并复制”后会用新码替换旧码，
并立即复制新码。列表在剩余 72 小时内显示小时和分钟倒计时，到期后明确标记“已到期”；公开查询统一提示
邮箱或查询码不正确。系统不会自动更换查询码，管理员必须手动生成新码并重新交付。

“有效期设置”决定新建邮箱和手动生成新码的全局有效天数。保存时可选择把所有现有查询码的到期时间统一改为
“保存时间 + 新有效天数”；该操作只调整到期时间，不更换查询码，并写入审计。

## 部署约束

邮箱读取依赖原生 IMAP TCP/TLS，只在 AWS Docker 中的 Node API 运行。生产启用邮箱查询前，
必须确认管理端同源 `/api` 指向该 Node API，且 EC2 安全组不额外开放 IMAP 入站端口。未经单独设计和验收，不得把应用专用
密码转发给外部邮件代查服务。

生产 API 从同一台 EC2 访问邮箱服务，因此 Gmail 和 iCloud 会看到相同的 AWS 出口 IP。邮箱保存在池中时不会维持 IMAP
长连接，也不会后台轮询；只有管理员验证或买家主动查询时才建立短连接。单个 API 实例对每家邮箱服务最多同时建立 4 个
连接，最多等待 24 个请求，超过队列或等待 12 秒后返回繁忙提示，避免大量邮箱同时查询时形成登录突发。多实例部署前必须把
此限制升级为跨实例共享限流，不能直接水平扩容绕过限制。

## 安全边界

- 应用专用密码和 Microsoft OAuth2 刷新令牌使用 AES-256-GCM 字段加密保存。
- 买家查询码保存带服务端密钥的 HMAC，并以 AES-256-GCM 加密保存管理员可复制值。
- 查询码到期时间单独保存；过期、停用、邮箱不存在和查询码错误使用相同公开响应。
- 公开查询按查询码哈希和来源 IP 哈希进行五分钟窗口限流。
- 邮件只读打开 INBOX，每次最多返回 20 封；单封原始内容最多读取 1 MB，正文最多返回 120,000 字符。
- 邮件 HTML 不渲染，远程图片和脚本不会加载；邮件正文不写入数据库。
- 授权失败会把邮箱标为“授权失效”，管理员更新并重新验证应用专用密码后才能恢复。
