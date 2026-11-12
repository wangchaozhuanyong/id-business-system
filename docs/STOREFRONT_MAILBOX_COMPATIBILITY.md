# 商城邮箱池切换与验收

适用对象为独立新版 ID 业务管理系统和现有 Vendure 商城。买家继续从订单或交付凭据进入 [商城查询页](https://moyaoai.com/mail-query)。

| 查询码 | 商城服务端处理方式 |
| --- | --- |
| 已发出的 ID 旧版 20 位码 | 按原码调用 ID 的 `POST /api/public/mailbox/query` |
| 独立新版 `MBX-` 码 | 使用同一个 ID 查询接口 |
| Vendure 的 `BUY-`、`MSTR-` 码 | 使用 Vendure 原有邮箱查询 |

ID 兼容接口接受 `{ "queryCode": "…", "limit": 5 }`，成功返回 `{ success: true, data: { email, items } }`。每封邮件含 `from`、`to`、`subject`、`body` 和 ISO 格式的 `savedAt`。商城仍使用现有邮件清洗和验证码提取。已停用、过期、错误或归属 Vendure 的码由 ID 返回 400。

## 迁移旧邮箱池

从旧系统的只读数据库快照导出下面的 JSON。可通过 `psql -X -qAt --output "$export_file"` 执行，先使用 `umask 077`。导出中保留原字段密文。时间戳以 UTC 输出，保留原到期值。

```sql
SET TIME ZONE 'UTC';
SELECT jsonb_build_object(
  'format', 'id-managed-mailbox-v1',
  'defaultValidDays', COALESCE((
    SELECT query_code_validity_days FROM id_business_v2_managed_mailbox_settings
    WHERE scope = 'global'
  ), 30),
  'rows', COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'email', email, 'label', label, 'provider', provider, 'status', status,
    'providerCredentialEncrypted', provider_credential_encrypted,
    'queryCodeEncrypted', query_code_encrypted, 'queryCodeHash', query_code_hash,
    'queryCodeExpiresAt', query_code_expires_at, 'updatedAt', updated_at,
    'lastQueriedAt', last_queried_at
  ) ORDER BY id), '[]'::jsonb)
)
FROM id_business_v2_managed_mailboxes;
```

在获授权的迁移环境中准备单独的私有 JSON 文件，字段为 `fieldEncryptionKey` 和 `hashSecret`，分别来自原服务的字段加密密钥和查询码校验密钥。两个文件均需当前运行用户持有，权限为 0600 或 0400。

```sh
node server/tools/legacy-mailbox-import-cli.mjs \
  --input "$legacy_export" --legacy-key-file "$legacy_keys"

node server/tools/legacy-mailbox-import-cli.mjs \
  --input "$legacy_export" --legacy-key-file "$legacy_keys" \
  --database "$staging_database" --expected-version "$mailbox_pool_version" --apply
```

第一条命令只核对格式、解密和查询码校验值。第二条对现有独立版数据库执行一次事务，保留原码、到期时间、启停状态和授权失败状态。全量相同的重复导入会跳过；编号、地址或查询码冲突时整批停止。目标邮箱池上限为 500 条。正式导入先在恢复副本验证。

历史行如果只保留校验值，需从已授权的原交付记录取回旧码，作为该行的 `recoveredQueryCode` 加入私有导出文件，再由工具核对原校验值。无法取得原码时，这批数据还不具备切换条件。Microsoft 邮箱需要与原 refresh token 匹配的 OAuth 应用，或在新版为同一条邮箱重新授权，随后用原查询码验证。

## 正式 HTTPS 接入与验收

1. 独立服务以原 ID 查询域名设置 `--mailbox-public-origin https://<原ID域名>`，保留本机业务库和账号配置。TLS 代理只把精确的 `/api/public/mailbox/query` 转给独立服务，保留原 Host、请求方法和 JSON 正文。当前程序仍监听回环地址。
2. 保持商城配置的 `ICLOUD_MANAGED_MAILBOX_QUERY_URL` 使用原 HTTPS 域名和原路径。在切换前用独立测试邮箱和隔离数据，经目标反向代理确认旧码、新码均可取信，核对邮件链接和有效期。再在商城验证苹果隐藏邮箱的两类码。
3. 先核对迁移前后的记录数、旧码到期时间、停用记录和 Microsoft 授权。对生产入口做切换前验证，并保留可回到原服务的精确路由配置。

## 本地证据

- 独立新版全量 341 项测试通过，覆盖旧数据解密导入、重复和冲突、旧码到期与停用、正式主机限制、商城响应格式以及新版本机查询。
- Vendure 的查询客户端与分流测试 30 项通过。另用实际 Vendure 查询客户端连接隔离 HTTP 适配器，核对旧码和新版码取信、验证码与验证链接，以及 `BUY-`、`MSTR-` 留在 Vendure。
- 合成 IMAP 邮件覆盖仅含 HTML 的验证链接以及服务器收件时间回退。
- 4371 本机预览已重载。390px 买家查询页使用合成响应验证旧码、新码和两类苹果隐藏邮箱码的界面分流。
- 正式旧库导入、真实邮箱、生产 HTTPS 代理和商城线上切换留待正式联调。

实现集中在 `server/tools/mailbox-pool.mjs`、`server/preview.mjs`、`server/local-business.mjs` 和 `server/tools/legacy-mailbox-import*.mjs`。邮箱工作进程、Microsoft 查询转发、本机买家和后台查询入口一并适配。现有 SQLite 文档继续加密保存，沿用原表结构。

## 2026-11-12 线上核查与配置修复

浏览器 AWS 登录和正确 CLI profile `vendure-production` 有效；旧账户 `vendure-prod` 的过期状态不能代表当前访问。商城在 Lightsail SSM 节点 `mi-04476e3f29a528ddc` 运行，核对版本为 `1dd8695a0a6f4c8a62ad0d4942eb8d92f22a1966`。线上进程、dotenv 及已部署源码确认上游仍为 `https://54-249-61-238.sslip.io/api/public/mailbox/query`。

ID 原启动入口未传 `mailboxPublicOrigin`，公网与正确 Host 的直连均为 404。用户授权继续后，补入 `mailboxPublicOrigin: publicOrigin` 并通过远端隔离金丝雀。沿用标准 `operations/run-app` 路径后，健康检查为 200，邮箱 GET 为 405，非法 POST 为 400；商城实际 GraphQL 调用也能正确返回非法或过期码提示。

用户指定现有唯一 iCloud 邮箱做真实查询，进一步发现应用镜像缺少 Python 3（`ENOENT`）。经用户明确批准，新增 `deploy/mailbox-runtime/Dockerfile`，保留 Node v24.22.1，补入 Python 3.11.2 和 CA 证书。远端无网络邮件解析测试、iCloud TLSv1.3 握手及应用隔离金丝雀均通过，再切换应用镜像；共用的 Node 镜像标识保持原值。

真实对照中，后台、ID 公共接口和商城均成功返回同样的 5 封邮件，标题、时间一致。商城识别的 1 个验证码与原邮件核对一致，10 个实际邮件锚点链接完整保留。样本没有明确的验证/登录链接，验证链接仅有合成测试依据；不将不存在的真实样本记为已验证。

同时发现后台先截断长邮件再提取验证码，导致该样本在后台漏显。`server/tools/mailbox-pool.mjs` 已在本地改为先从受限完整正文提取、再生成原长度预览；3 项新回归与 3 项既有定向检查通过。此代码修复与页面新版纳入同一次正式网站发布，实际发布状态以线上回执为准。

备份和表格同步按既有 PartOf 关系恢复，其既有 runner 会读取 app 镜像，因此随应用采用新镜像；没有修改它们的源码或配置。充值执行器、适配器、任务服务与 worker 在本轮切换中保持原容器。后续发布须保留独立应用镜像选择、邮箱公开选项及标准启动路径。完整执行、失败尝试及最新核查状态见 `.runtime/mailbox-redesign-20261112/RESULT.md` 与 `production/` 回执；未提交或推送 Git。
