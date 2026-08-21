# 受管邮箱运行说明

## 支持范围

- Gmail：`imap.gmail.com:993`，TLS。
- iCloud、me.com、mac.com：`imap.mail.me.com:993`，TLS。
- 每个邮箱必须使用平台生成的应用专用密码，不能填写普通登录密码。
- 买家使用系统另行生成的 `邮箱----查询码`，该查询码不是邮箱密码。

Google 账号需先开启两步验证后生成应用专用密码。部分组织账号、仅安全密钥两步验证或高级保护账号
可能不提供应用专用密码，此类账号后续应接入 Google OAuth，不能使用普通密码替代。Apple 账号需开启
双重认证并生成应用专用密码。

## 本地运行

1. 配置项目现有 `DATABASE_URL`、`FIELD_ENCRYPTION_KEY` 和 `HASH_SECRET`。
2. 执行 `npm run prisma:migrate:deploy --workspace @apple-business/api`。
3. 使用 `npm run dev:api` 启动 Node API，再使用 `npm run dev:admin` 启动管理端。
4. 管理员从个人工作区打开“邮件查看器”，在“邮箱池管理”中验证并添加邮箱。
5. 把创建结果中只显示一次的买家查询凭据交付给买家；买家访问 `/mailbox` 查询。

应用专用密码、买家查询码和邮件内容不得写入命令行、工单、日志或源码。创建与重置结果的完整查询码
只返回一次；遗失后必须重置，系统不能恢复原值。

## 部署约束

邮箱读取依赖原生 IMAP TCP/TLS。当前 AWS/MySQL 生产链路由 Node/Docker API 运行该连接器，并固定
`SUPABASE_EDGE_FUNCTION=false`；前端通过同源反向代理访问该 API。`SUPABASE_EDGE_FUNCTION=true` 时
连接器仍会拒绝执行并返回“邮件查询服务尚未配置”。未经单独设计和验收，不得把应用专用密码转发给
外部邮件代查服务。

## 安全边界

- 应用专用密码使用 AES-256-GCM 字段加密保存。
- 买家查询码只保存带服务端密钥的 HMAC 和末四位提示。
- 公开查询按邮箱哈希和来源 IP 哈希进行五分钟窗口限流。
- 邮件只读打开 INBOX，每次最多返回 20 封；单封原始内容最多读取 1 MB，正文最多返回 120,000 字符。
- 邮件 HTML 不渲染，远程图片和脚本不会加载；邮件正文不写入数据库。
- 授权失败会把邮箱标为“授权失效”，管理员更新并重新验证应用专用密码后才能恢复。
